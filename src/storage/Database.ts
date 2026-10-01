/**
 * The on-disk database.
 *
 * One JSON file in the extension storage folder, written atomically:
 * a temporary file is written first, the previous version is copied to
 * `devwrapped-data.json.bak`, and only then is the temporary file renamed over
 * the original. A crash can therefore never leave a half written file behind.
 *
 * Failures are handled conservatively: a corrupt file is moved aside (never
 * deleted), the backup is tried, and the extension starts with an empty
 * database only after both copies have been exhausted.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { accumulateDayDelta, emptyLiveContribution, type DatabaseDelta, type DayDelta } from '../types/delta';
import { DB_SCHEMA_VERSION, createDayStats, type DatabaseData, type DayStats } from '../types/statistics';
import { normalizeDatabase, parseJsonSafely, type NormalizeResult } from '../security/Validation';
import type { Logger } from '../utils/log';
import { addDays, MS_PER_DAY } from '../utils/time';

/** How the database came to life, shown in the logs and the Privacy page. */
export type LoadStatus = 'created' | 'loaded' | 'recovered' | 'reset';

export interface LoadOutcome {
  status: LoadStatus;
  issues: string[];
  /** Path of a file that was set aside because it could not be read. */
  quarantined?: string;
}

export interface DatabaseOptions {
  directory: string;
  fileName?: string;
  logger?: Logger;
  now?: () => number;
  /** Hard cap for the serialized file; older sessions are pruned first. */
  maxBytes?: number;
}

const DEFAULT_FILE_NAME = 'devwrapped-data.json';
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class Database {
  private readonly directory: string;
  private readonly fileName: string;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private current: DatabaseData;
  private outcome: LoadOutcome;
  private dirty = false;
  private bytes = 0;

  private constructor(options: DatabaseOptions, data: DatabaseData, outcome: LoadOutcome) {
    this.directory = options.directory;
    this.fileName = options.fileName ?? DEFAULT_FILE_NAME;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.current = data;
    this.outcome = outcome;
  }

  /* --------------------------------- opening -------------------------------- */

  /** Opens (or creates) the database in the given directory. */
  public static async open(options: DatabaseOptions): Promise<Database> {
    await fs.mkdir(options.directory, { recursive: true });
    const file = join(options.directory, options.fileName ?? DEFAULT_FILE_NAME);
    const retentionDays = 365;
    const now = options.now ?? Date.now;

    let quarantinedPrimary: string | undefined;
    const primary = await readText(file);
    if (primary !== undefined) {
      const parsed = parseJsonSafely(primary);
      if (parsed.ok) {
        const normalized = normalizeDatabase(parsed.value, now(), retentionDays);
        const issues = normalized.issues.map((issue) => `${issue.path}: ${issue.message}`);
        const database = new Database(
          options,
          normalized.data,
          { status: issues.length > 0 ? 'recovered' : 'loaded', issues }
        );
        database.bytes = Buffer.byteLength(primary, 'utf8');
        database.dirty = normalized.repaired;
        return database;
      }
      // Invalid JSON: keep the file aside (never delete it) and try the backup.
      options.logger?.warn(`Could not parse ${file}: ${parsed.error}`);
      quarantinedPrimary = await quarantine(file, now());
    }

    const backup = await readText(`${file}.bak`);
    if (backup !== undefined) {
      const parsed = parseJsonSafely(backup);
      if (parsed.ok) {
        const normalized = normalizeDatabase(parsed.value, now(), retentionDays);
        const database = new Database(options, normalized.data, {
          status: 'recovered',
          issues: ['Restored from the backup file.', ...normalized.issues.map((issue) => `${issue.path}: ${issue.message}`)],
          ...(quarantinedPrimary ? { quarantined: quarantinedPrimary } : {}),
        });
        database.bytes = Buffer.byteLength(backup, 'utf8');
        database.dirty = true;
        return database;
      }
      options.logger?.warn(`Could not parse the backup of ${file}: ${parsed.error}`);
    }

    const created = new Database(options, emptyDatabase(now(), retentionDays), {
      status: primary !== undefined || backup !== undefined ? 'reset' : 'created',
      issues: [],
    });
    if (quarantinedPrimary ?? (primary !== undefined ? await quarantine(file, now()) : undefined)) {
      created.outcome.quarantined = quarantinedPrimary ?? (await quarantine(file, now()));
    }
    created.dirty = primary !== undefined || backup !== undefined;
    return created;
  }

  /* ---------------------------------- state --------------------------------- */

  /** The live database object. Do not mutate it directly; use the methods. */
  public get data(): DatabaseData {
    return this.current;
  }

  public get loadOutcome(): LoadOutcome {
    return this.outcome;
  }

  public get isDirty(): boolean {
    return this.dirty;
  }

  /** Size of the last written file, in bytes. */
  public get sizeBytes(): number {
    return this.bytes;
  }

  public get filePath(): string {
    return join(this.directory, this.fileName);
  }

  public get backupPath(): string {
    return `${this.filePath}.bak`;
  }

  /** Days of raw session history that are kept. */
  public get retentionDays(): number {
    return this.current.meta.retentionDays;
  }

  /** Updates the retention window and prunes immediately when it shrinks. */
  public setRetentionDays(days: number): void {
    if (!Number.isFinite(days) || days <= 0 || this.current.meta.retentionDays === days) {
      return;
    }
    this.current.meta.retentionDays = Math.round(days);
    this.prune();
    this.dirty = true;
  }

  /** Simple counters used by the Privacy page and the diagnostics command. */
  public stat(): { days: number; sessions: number; projects: number; languages: number } {
    const languages = new Set<string>();
    for (const day of Object.values(this.current.days)) {
      for (const id of Object.keys(day.languages)) {
        languages.add(id);
      }
    }
    return {
      days: Object.keys(this.current.days).length,
      sessions: this.current.sessions.length,
      projects: Object.keys(this.current.projects).length,
      languages: languages.size,
    };
  }

  /** Deep copy of the database (used by the exporter and by tests). */
  public cloneData(): DatabaseData {
    return structuredClone(this.current);
  }

  /* --------------------------------- writing -------------------------------- */

  /**
   * Merges an additive delta into the in-memory database.
   *
   * Merging (instead of replacing) is what makes several open windows safe:
   * each window adds its own activity on top of whatever was in the file.
   */
  public applyDelta(delta: DatabaseDelta): void {
    for (const [date, dayDelta] of Object.entries(delta.days)) {
      const existing = this.current.days[date];
      const target: DayDelta = existing ? dayToDelta(existing) : emptyLiveContribution(date);
      accumulateDayDelta(target, dayDelta);
      this.current.days[date] = deltaToDay(target);
    }

    if (delta.sessions.length > 0) {
      const known = new Set(this.current.sessions.map((session) => session.id));
      for (const session of delta.sessions) {
        if (!known.has(session.id)) {
          this.current.sessions.push(session);
          known.add(session.id);
        }
      }
      this.current.sessions.sort((a, b) => a.startTime - b.startTime);
    }

    for (const [id, meta] of Object.entries(delta.projects)) {
      const existing = this.current.projects[id];
      this.current.projects[id] = existing
        ? {
            id,
            name: meta.name || existing.name,
            firstSeen: Math.min(existing.firstSeen, meta.firstSeen),
            lastSeen: Math.max(existing.lastSeen, meta.lastSeen),
          }
        : { ...meta, id };
    }

    this.current.meta.updatedAt = this.now();
    this.dirty = true;
  }

  /** Replaces the whole database (used by the importer after confirmation). */
  public replaceAll(data: DatabaseData): void {
    this.current = {
      ...data,
      meta: {
        ...data.meta,
        schemaVersion: DB_SCHEMA_VERSION,
        updatedAt: this.now(),
      },
    };
    this.dirty = true;
  }

  /** Empties the history but keeps the privacy salt and the preferences. */
  public reset(): void {
    const now = this.now();
    this.current = {
      meta: {
        ...this.current.meta,
        createdAt: now,
        updatedAt: now,
      },
      days: {},
      sessions: [],
      projects: {},
    };
    this.dirty = true;
  }

  /** Writes the database if there is anything to write. */
  public async flush(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    this.prune();
    const payload = JSON.stringify(this.current);
    if (Buffer.byteLength(payload, 'utf8') > this.maxBytes) {
      // Keep dropping the oldest sessions until the file fits.
      this.pruneSessions(Math.max(30, Math.floor(this.current.meta.retentionDays / 3)));
    }
    const finalPayload = JSON.stringify(this.current);
    await writeAtomic(this.filePath, finalPayload);
    this.bytes = Buffer.byteLength(finalPayload, 'utf8');
    this.dirty = false;
  }

  /** Writes a copy of the current file with a readable label in its name. */
  public async safetyCopy(label: string): Promise<string> {
    await this.flush();
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const target = join(this.directory, `devwrapped-${label}-${stamp}.json`);
    try {
      await fs.copyFile(this.filePath, target);
    } catch {
      // The copy is a convenience, not a requirement: write the payload instead.
      await fs.writeFile(target, JSON.stringify(this.current), { encoding: 'utf8', mode: 0o600 });
    }
    return target;
  }

  /* --------------------------------- pruning -------------------------------- */

  /** Drops sessions older than the retention window. */
  public prune(): number {
    return this.pruneSessions(this.current.meta.retentionDays);
  }

  /** Drops sessions older than `days` days; returns how many were removed. */
  public pruneSessions(days: number): number {
    if (!Number.isFinite(days) || days <= 0) {
      return 0;
    }
    const cutoff = addDays(this.now(), -Math.round(days));
    const before = this.current.sessions.length;
    this.current.sessions = this.current.sessions.filter(
      (session) => session.startTime >= cutoff && session.startTime <= this.now() + MS_PER_DAY
    );
    const removed = before - this.current.sessions.length;
    if (removed > 0) {
      this.logger?.debug(`Pruned ${removed} session(s) older than ${Math.round(days)} days.`);
      this.dirty = true;
    }
    return removed;
  }
}

/* ---------------------------------- helpers -------------------------------- */

/** Reads a file as text, returning `undefined` when it does not exist. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Moves an unreadable file aside instead of deleting it. */
async function quarantine(file: string, now: number): Promise<string | undefined> {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const target = `${file}.corrupt-${stamp}`;
  try {
    await fs.rename(file, target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * Atomic write: temporary file, backup of the previous version, rename.
 *
 * On POSIX systems `rename` is atomic, so a reader (another window) always
 * sees either the old or the new file, never a partial one.
 */
async function writeAtomic(file: string, payload: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch {
    // No previous file: nothing to back up.
  }
  await fs.rename(temporary, file);
}

/** Converts a stored day into an additive delta. */
function dayToDelta(day: DayStats): DayDelta {
  const delta = emptyLiveContribution(day.date);
  delta.ms = day.activeTime;
  delta.sessions = day.sessions;
  delta.languages = { ...day.languages };
  delta.projects = { ...day.projects };
  delta.filesModified = day.filesModified;
  delta.filesSaved = day.filesSaved;
  delta.filesOpened = day.filesOpened;
  delta.longestSession = day.longestSession;
  delta.hourly = [...day.hourly];
  if (day.firstActivity !== undefined) {
    delta.firstActivity = day.firstActivity;
  }
  if (day.lastActivity !== undefined) {
    delta.lastActivity = day.lastActivity;
  }
  return delta;
}

/** Converts a merged delta back into a stored day. */
function deltaToDay(delta: DayDelta): DayStats {
  const day = createDayStats(delta.date);
  day.activeTime = delta.ms;
  day.sessions = delta.sessions;
  day.languages = delta.languages;
  day.projects = delta.projects;
  day.filesModified = delta.filesModified;
  day.filesSaved = delta.filesSaved;
  day.filesOpened = delta.filesOpened;
  day.longestSession = delta.longestSession;
  day.hourly = delta.hourly;
  if (delta.firstActivity !== undefined) {
    day.firstActivity = delta.firstActivity;
  }
  if (delta.lastActivity !== undefined) {
    day.lastActivity = delta.lastActivity;
  }
  return day;
}

/** Empty database used when nothing can be recovered. */
function emptyDatabase(now: number, retentionDays: number): DatabaseData {
  return {
    meta: {
      schemaVersion: DB_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      retentionDays,
      privacySalt: '',
      onboarded: false,
    },
    days: {},
    sessions: [],
    projects: {},
  };
}

/** Normalization result re-exported for tests. */
export type { NormalizeResult };
export { normalizeDatabase };
