/**
 * Session lifecycle.
 *
 * A session starts when the user begins interacting with the editor and ends
 * after `inactivityTimeout` minutes without activity. Only *active* time is
 * counted: idle stretches are discarded and a session is split when the user
 * comes back after a long pause, so "VS Code is open" is never mistaken for
 * "the user is coding".
 *
 * The manager also accumulates the live (not yet flushed) contribution of the
 * current session, keyed by local day so a session that crosses midnight is
 * attributed to both days instead of being lost.
 */

import { accumulateDayDelta, emptyLiveContribution, type DayDelta } from '../types/delta';
import type { CodingSession, DateKey } from '../types/statistics';
import { createSessionId } from '../utils/ids';
import { MS_PER_HOUR, dateKey, hourOfDay } from '../utils/time';

export interface SessionContext {
  language?: string;
  projectId?: string;
  projectName?: string;
}

export interface SessionManagerOptions {
  /** Minutes without activity after which the current session ends. */
  inactivityTimeoutMs: () => number;
  /** Record per-language totals. */
  trackLanguages: () => boolean;
  /** Record per-project totals. */
  trackProjects: () => boolean;
  /** Injected clock, for tests. */
  now: () => number;
}

export interface SessionSummary {
  id: string;
  startTime: number;
  lastActivity: number;
  activeMs: number;
  language?: string;
  project?: string;
  projectName?: string;
  dominantLanguageMs: Record<string, number>;
}

/** Result of ending a session: the stored record plus the day it belongs to. */
export interface EndedSession {
  session: CodingSession;
  dayKey: DateKey;
}

/** Why a session ended (kept for logging, never stored). */
export type SessionEndReason = 'timeout' | 'shutdown' | 'pause' | 'disabled' | 'reset';

interface RunningSession {
  id: string;
  startTime: number;
  activeMs: number;
  lastActivity: number;
  firstLanguage?: string;
  languageMs: Record<string, number>;
  project?: string;
  projectName?: string;
  projectMs: Record<string, number>;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;
  /** Day key -> pending additive contribution. */
  private pending = new Map<DateKey, DayDelta>();
  private session: RunningSession | undefined;

  public constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  /* ------------------------------- lifecycle ------------------------------ */

  /** Starts a session when none is running; returns `true` when one started. */
  public start(context: SessionContext = {}): boolean {
    if (this.session) {
      this.applyContext(context);
      return false;
    }
    const now = this.options.now();
    this.session = {
      id: createSessionId(),
      startTime: now,
      activeMs: 0,
      lastActivity: now,
      languageMs: {},
      projectMs: {},
    };
    this.applyContext(context);
    return true;
  }

  /**
   * Ends the running session and returns the record to store.
   *
   * `undefined` when nothing was running or when the session has less than one
   * second of active time — an accidental keypress should not create a session.
   */
  public end(reason: SessionEndReason, at = this.options.now()): EndedSession | undefined {
    const session = this.session;
    this.session = undefined;
    if (!session) {
      return undefined;
    }
    const activeMs = Math.max(0, Math.round(session.activeMs));
    if (activeMs < 1000) {
      return undefined;
    }
    void reason;
    const endTime = Math.max(session.startTime, Math.round(at));
    const dayKey = dateKey(session.startTime);
    const record: CodingSession = {
      id: session.id,
      startTime: session.startTime,
      endTime,
      duration: activeMs,
    };
    const language = dominantKey(session.languageMs) ?? session.firstLanguage;
    if (language) {
      record.language = language;
    }
    if (session.project) {
      record.project = session.project;
    }
    if (session.projectName) {
      record.projectName = session.projectName;
    }
    const day = this.dayDelta(dayKey);
    day.sessions += 1;
    day.longestSession = Math.max(day.longestSession, activeMs);
    return { session: record, dayKey };
  }

  /** Forgets the running session without producing a record (used on reset). */
  public cancel(): void {
    this.session = undefined;
    this.pending.clear();
  }

  /* -------------------------------- activity ------------------------------ */

  /**
   * Records `ms` of active time ending at `at`.
   *
   * The slice is attributed to the language and project that were active while
   * it was spent, and split across hour buckets when it crosses an hour
   * boundary, so the hourly histogram stays exact.
   */
  public recordActive(ms: number, at: number, context: SessionContext = {}): void {
    if (!Number.isFinite(ms) || ms <= 0) {
      return;
    }
    if (!this.session) {
      this.start(context);
    }
    const session = this.session;
    if (!session) {
      return;
    }
    const bounded = Math.min(ms, this.options.inactivityTimeoutMs());
    session.activeMs += bounded;
    session.lastActivity = at;
    this.applyContext(context);

    const language = this.options.trackLanguages() ? context.language : undefined;
    const projectId = this.options.trackProjects() ? context.projectId : undefined;

    if (language) {
      session.languageMs[language] = (session.languageMs[language] ?? 0) + bounded;
    }
    if (projectId) {
      session.projectMs[projectId] = (session.projectMs[projectId] ?? 0) + bounded;
    }

    this.forEachHourSlice(at - bounded, at, (sliceStart, sliceMs) => {
      const day = this.dayDelta(sliceStart);
      day.ms += sliceMs;
      const hour = hourOfDay(sliceStart);
      day.hourly[hour] = (day.hourly[hour] ?? 0) + sliceMs;
      if (language) {
        day.languages[language] = (day.languages[language] ?? 0) + sliceMs;
      }
      if (projectId) {
        day.projects[projectId] = (day.projects[projectId] ?? 0) + sliceMs;
        if (context.projectName) {
          day.projectNames[projectId] = context.projectName;
        }
      }
      if (day.firstActivity === undefined || sliceStart < day.firstActivity) {
        day.firstActivity = sliceStart;
      }
      if (day.lastActivity === undefined || at > day.lastActivity) {
        day.lastActivity = at;
      }
    });
  }

  /** Switches the language/project of the running session. */
  public applyContext(context: SessionContext): void {
    const session = this.session;
    if (!session) {
      return;
    }
    if (context.language && this.options.trackLanguages()) {
      session.firstLanguage = session.firstLanguage ?? context.language;
      session.languageMs[context.language] = session.languageMs[context.language] ?? 0;
    }
    if (context.projectId && this.options.trackProjects()) {
      session.project = context.projectId;
      session.projectName = context.projectName ?? session.projectName;
      session.projectMs[context.projectId] = session.projectMs[context.projectId] ?? 0;
    }
  }

  /** Counts one unique document edit/save/open for the given day. */
  public recordFile(kind: 'modified' | 'saved' | 'opened', at: number): void {
    const day = this.dayDelta(at);
    if (kind === 'modified') {
      day.filesModified += 1;
    } else if (kind === 'saved') {
      day.filesSaved += 1;
    } else {
      day.filesOpened += 1;
    }
  }

  /* --------------------------------- state -------------------------------- */

  public get isActive(): boolean {
    return this.session !== undefined;
  }

  public get startTime(): number | undefined {
    return this.session?.startTime;
  }

  public get activeMs(): number {
    return this.session?.activeMs ?? 0;
  }

  /** Idle milliseconds since the last recorded activity. */
  public get idleMs(): number {
    if (!this.session) {
      return 0;
    }
    return Math.max(0, this.options.now() - this.session.lastActivity);
  }

  /** Milliseconds until the current session times out (for the UI). */
  public get remainingMs(): number {
    if (!this.session) {
      return 0;
    }
    return Math.max(0, this.options.inactivityTimeoutMs() - this.idleMs);
  }

  public summary(): SessionSummary | undefined {
    const session = this.session;
    if (!session) {
      return undefined;
    }
    const summary: SessionSummary = {
      id: session.id,
      startTime: session.startTime,
      lastActivity: session.lastActivity,
      activeMs: session.activeMs,
      dominantLanguageMs: { ...session.languageMs },
    };
    const language = dominantKey(session.languageMs) ?? session.firstLanguage;
    if (language) {
      summary.language = language;
    }
    if (session.project) {
      summary.project = session.project;
    }
    if (session.projectName) {
      summary.projectName = session.projectName;
    }
    return summary;
  }

  /** Live contribution of a specific day, when one is pending. */
  public liveFor(date: DateKey): DayDelta | undefined {
    return this.pending.get(date);
  }

  /**
   * Returns and clears every pending day delta.
   *
   * Called on flush; the returned deltas are additive, so the storage layer
   * merges them without re-reading the file.
   */
  public takeDeltas(): DayDelta[] {
    const deltas = [...this.pending.values()];
    this.pending.clear();
    return deltas;
  }

  /** Keeps a delta in the pending map (used when a flush fails). */
  public restore(deltas: DayDelta[]): void {
    for (const delta of deltas) {
      const existing = this.pending.get(delta.date);
      if (existing) {
        accumulateDayDelta(existing, delta);
      } else {
        this.pending.set(delta.date, delta);
      }
    }
  }

  /* -------------------------------- private ------------------------------- */

  /** Day accumulator for a timestamp or a day key, created on demand. */
  private dayDelta(when: number | DateKey): DayDelta {
    const key = typeof when === 'string' ? when : dateKey(when);
    let day = this.pending.get(key);
    if (!day) {
      day = emptyLiveContribution(key);
      this.pending.set(key, day);
    }
    return day;
  }

  /** Splits `[start, end)` into chunks that never cross a local hour boundary. */
  private forEachHourSlice(start: number, end: number, visit: (sliceStart: number, sliceMs: number) => void): void {
    let cursor = Math.max(0, Math.min(start, end));
    const boundedEnd = Math.max(start, end);
    // A single interaction can never cover more than the timeout window; the
    // guard only exists to make a corrupted timestamp harmless.
    const guard = Math.ceil((boundedEnd - cursor) / MS_PER_HOUR) + 2;
    for (let index = 0; index < guard && cursor < boundedEnd; index += 1) {
      const sliceEnd = Math.min(nextHourBoundary(cursor), boundedEnd);
      const sliceMs = sliceEnd - cursor;
      if (sliceMs > 0) {
        visit(cursor, sliceMs);
      }
      cursor = sliceEnd;
    }
  }
}

/** Start of the local hour strictly after `ts`. */
function nextHourBoundary(ts: number): number {
  const date = new Date(ts);
  date.setMinutes(60, 0, 0);
  const boundary = date.getTime();
  return boundary > ts ? boundary : ts + MS_PER_HOUR;
}

/** Key with the largest accumulated value. */
function dominantKey(values: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestValue = -1;
  for (const [key, value] of Object.entries(values)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}
