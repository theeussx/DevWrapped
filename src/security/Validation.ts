/**
 * Schema validation and normalization for everything that enters the
 * extension: imported backups, database files found on disk, deltas produced
 * by the trackers and messages coming from the webview.
 *
 * The policy is "parse, do not trust": every field is checked, unknown fields
 * are dropped, counters are clamped to sane ranges and a validation failure
 * never throws out of the storage layer.
 */

import {
  DB_SCHEMA_VERSION,
  createDayStats,
  type CodingSession,
  type DatabaseData,
  type DatabaseMeta,
  type DayStats,
  type ProjectMeta,
} from '../types/statistics';
import { INACTIVITY_TIMEOUT_OPTIONS, MINIMUM_ACTIVE_TIME_OPTIONS, SESSION_RETENTION_OPTIONS } from '../types/config';
import { isValidDateKey } from '../utils/time';
import { sanitizeLanguageId, sanitizeProjectName, sanitizeText } from './Sanitization';

/* ------------------------------- primitives ------------------------------- */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

export interface Schema<T> {
  readonly kind: string;
  validate(value: unknown, path: string, issues: ValidationIssue[]): T | undefined;
}

/** Marker for optional object fields. */
export interface OptionalSchemaMarker<T> {
  readonly optional: true;
  readonly schema: Schema<T>;
}

export function optional<T>(schema: Schema<T>): OptionalSchemaMarker<T> {
  return { optional: true, schema };
}

function isOptionalMarker(value: unknown): value is OptionalSchemaMarker<unknown> {
  return typeof value === 'object' && value !== null && (value as { optional?: unknown }).optional === true;
}

export const stringSchema = (options: { maxLength?: number; pattern?: RegExp; trim?: boolean } = {}): Schema<string> => ({
  kind: 'string',
  validate(value, path, issues) {
    if (typeof value !== 'string') {
      issues.push({ path, message: 'expected a string' });
      return undefined;
    }
    let result = options.trim === false ? value : value.trim();
    if (options.pattern && !options.pattern.test(result)) {
      issues.push({ path, message: 'does not match the expected format' });
      return undefined;
    }
    if (options.maxLength !== undefined && result.length > options.maxLength) {
      result = result.slice(0, options.maxLength);
    }
    return result;
  },
});

export const numberSchema = (
  options: { min?: number; max?: number; integer?: boolean; fallback?: number } = {}
): Schema<number> => ({
  kind: 'number',
  validate(value, path, issues) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      if (options.fallback !== undefined) {
        return options.fallback;
      }
      issues.push({ path, message: 'expected a finite number' });
      return undefined;
    }
    let result = options.integer ? Math.round(parsed) : parsed;
    if (options.min !== undefined && result < options.min) {
      result = options.min;
    }
    if (options.max !== undefined && result > options.max) {
      result = options.max;
    }
    return result;
  },
});

export const booleanSchema = (fallback = false): Schema<boolean> => ({
  kind: 'boolean',
  validate(value, path, issues) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (value === 'true' || value === 1) {
      return true;
    }
    if (value === 'false' || value === 0) {
      return false;
    }
    if (value === undefined || value === null) {
      return fallback;
    }
    issues.push({ path, message: 'expected a boolean' });
    return undefined;
  },
});

export const literalSchema = <T extends string | number>(allowed: readonly T[], fallback?: T): Schema<T> => ({
  kind: 'literal',
  validate(value, path, issues) {
    if ((allowed as readonly unknown[]).includes(value)) {
      return value as T;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    issues.push({ path, message: `expected one of ${allowed.join(', ')}` });
    return undefined;
  },
});

/** Validates a `Record<string, number>` of counters, clamped to a maximum. */
export const countMapSchema = (options: { maxEntries: number; maxValue: number }): Schema<Record<string, number>> => ({
  kind: 'countMap',
  validate(value, path, issues) {
    if (value === undefined || value === null) {
      return {};
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ path, message: 'expected an object of numbers' });
      return undefined;
    }
    const result: Record<string, number> = {};
    let entries = 0;
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const key = sanitizeText(rawKey, 64);
      if (key.length === 0) {
        continue;
      }
      const parsed = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        continue;
      }
      result[key] = Math.min(parsed, options.maxValue);
      entries += 1;
      if (entries >= options.maxEntries) {
        break;
      }
    }
    return result;
  },
});

/** Validates an object against a field map, dropping unknown fields. */
export function objectSchema<T extends object>(fields: {
  [K in keyof T]-?: Schema<T[K]> | OptionalSchemaMarker<T[K]>;
}, options: { warnOnUnknown?: boolean } = {}): Schema<T> {
  const known = new Set(Object.keys(fields));
  const fieldEntries = Object.entries(fields as Record<string, Schema<unknown> | OptionalSchemaMarker<unknown>>);
  return {
    kind: 'object',
    validate(value, path, issues) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: 'expected an object' });
        return undefined;
      }
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, schemaOrMarker] of fieldEntries) {
        const schema = isOptionalMarker(schemaOrMarker) ? schemaOrMarker.schema : schemaOrMarker;
        const isOptionalField = isOptionalMarker(schemaOrMarker);
        const fieldPath = `${path}.${key}`;
        const raw = source[key];
        if (raw === undefined && isOptionalField) {
          continue;
        }
        const validated = schema.validate(raw, fieldPath, issues);
        if (validated !== undefined) {
          result[key] = validated;
        }
      }
      if (options.warnOnUnknown) {
        for (const key of Object.keys(source)) {
          if (!known.has(key)) {
            issues.push({ path: `${path}.${key}`, message: 'unknown field (ignored)' });
          }
        }
      }
      return result as T;
    },
  };
}

/** Validates an array, stopping after `maxItems` entries. */
export const arraySchema = <T>(item: Schema<T>, maxItems: number): Schema<T[]> => ({
  kind: 'array',
  validate(value, path, issues) {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'expected an array' });
      return undefined;
    }
    const result: T[] = [];
    for (let index = 0; index < value.length && result.length < maxItems; index += 1) {
      const validated = item.validate(value[index], `${path}[${index}]`, issues);
      if (validated !== undefined) {
        result.push(validated);
      }
    }
    return result;
  },
});

/* --------------------------------- helpers -------------------------------- */

/** Parses JSON without ever throwing, and rejects oversized input. */
export function parseJsonSafely(text: string, maxBytes = MAX_IMPORT_BYTES): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.length > maxBytes) {
    return { ok: false, error: `The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: `The file is not valid JSON: ${(error as Error).message}` };
  }
}

/**
 * Keys that must never appear in imported data.
 *
 * Dev Wrapped never stores file names, paths or contents; if a backup
 * contains them (an older build, a hand edited file, a different tool) the
 * import refuses to proceed rather than writing them back to disk.
 */
export const FORBIDDEN_KEYS = new Set([
  'content',
  'contents',
  'filecontent',
  'filecontents',
  'filepath',
  'filepaths',
  'filename',
  'filenames',
  'path',
  'paths',
  'source',
  'sourcecode',
  'snippet',
  'snippets',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'apikey',
  'apisecret',
  'env',
  'environment',
  'terminaloutput',
  'command',
  'commands',
  'keystrokes',
  'keyspressed',
  'clipboard',
]);

/** Finds forbidden keys at any depth (sorted, deterministic). */
export function findForbiddenKeys(value: unknown, limit = 50): string[] {
  const hits: string[] = [];
  const stack: Array<{ path: string; node: unknown }> = [{ path: '$', node: value }];
  while (stack.length > 0 && hits.length < limit) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const node = current.node;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length && index < 500; index += 1) {
        stack.push({ path: `${current.path}[${index}]`, node: node[index] });
      }
      continue;
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
          hits.push(`${current.path}.${key}`);
        }
        stack.push({ path: `${current.path}.${key}`, node: (node as Record<string, unknown>)[key] });
      }
    }
  }
  return hits.sort();
}

/** Maximum size of an imported backup (checked before reading the file). */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** Maximum number of days kept in one database (about 30 years). */
export const MAX_DAYS = 11_000;
/** Maximum number of raw sessions kept in one database. */
export const MAX_SESSIONS = 200_000;
/** Maximum number of projects kept in one database. */
export const MAX_PROJECTS = 5_000;

/* ------------------------------- data model ------------------------------- */

const MAX_MS_PER_DAY = 24 * 60 * 60 * 1000;

const sessionSchema: Schema<CodingSession> = objectSchema<CodingSession>({
  id: stringSchema({ maxLength: 64 }),
  startTime: numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
  endTime: numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
  duration: numberSchema({ min: 0, max: MAX_MS_PER_DAY, integer: true }),
  language: optional(stringSchema({ maxLength: 40, pattern: /^[a-z0-9][a-z0-9+#._-]*$/ })),
  project: optional(stringSchema({ maxLength: 32, pattern: /^[0-9a-f]+$/ })),
  projectName: optional(stringSchema({ maxLength: 64 })),
});

const projectMetaSchema: Schema<ProjectMeta> = objectSchema<ProjectMeta>({
  id: stringSchema({ maxLength: 32, pattern: /^[0-9a-f]+$/ }),
  name: stringSchema({ maxLength: 64 }),
  firstSeen: numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
  lastSeen: numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }),
});

const hourlySchema: Schema<number[]> = {
  kind: 'hourly',
  validate(value, path, issues) {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'expected an array of 24 numbers' });
      return undefined;
    }
    const result = new Array<number>(24).fill(0);
    const source = value as unknown[];
    for (let hour = 0; hour < 24; hour += 1) {
      const raw: unknown = source[hour];
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      result[hour] = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_MS_PER_DAY) : 0;
    }
    return result;
  },
};

const metaSchema: Schema<DatabaseMeta> = objectSchema<DatabaseMeta>({
  schemaVersion: numberSchema({ min: 1, max: DB_SCHEMA_VERSION, integer: true, fallback: DB_SCHEMA_VERSION }),
  createdAt: numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, fallback: 0 }),
  updatedAt: numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, fallback: 0 }),
  retentionDays: literalSchema(SESSION_RETENTION_OPTIONS, SESSION_RETENTION_OPTIONS[1]),
  privacySalt: stringSchema({ maxLength: 128, pattern: /^[0-9a-f]*$/ }),
  onboarded: booleanSchema(false),
  lastWrappedYear: optional(numberSchema({ min: 2000, max: 2100, integer: true })),
  pausedUntil: optional(numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })),
});

const daySchema: Schema<DayStats> = objectSchema<DayStats>({
  date: stringSchema({ maxLength: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
  activeTime: numberSchema({ min: 0, max: MAX_MS_PER_DAY, integer: true }),
  sessions: numberSchema({ min: 0, max: 1000, integer: true }),
  languages: countMapSchema({ maxEntries: 200, maxValue: MAX_MS_PER_DAY }),
  projects: countMapSchema({ maxEntries: 500, maxValue: MAX_MS_PER_DAY }),
  filesModified: numberSchema({ min: 0, max: 100_000, integer: true }),
  filesSaved: numberSchema({ min: 0, max: 100_000, integer: true }),
  filesOpened: numberSchema({ min: 0, max: 100_000, integer: true }),
  firstActivity: optional(numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })),
  lastActivity: optional(numberSchema({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })),
  longestSession: numberSchema({ min: 0, max: MAX_MS_PER_DAY, integer: true }),
  hourly: hourlySchema,
});

const daysSchema: Schema<Record<string, DayStats>> = {
  kind: 'days',
  validate(value, path, issues) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ path, message: 'expected an object of days' });
      return undefined;
    }
    const result: Record<string, DayStats> = {};
    let kept = 0;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!isValidDateKey(key)) {
        continue;
      }
      const parsed = daySchema.validate(raw, `${path}.${key}`, issues);
      if (parsed === undefined) {
        continue;
      }
      result[key] = { ...parsed, date: key };
      kept += 1;
      if (kept >= MAX_DAYS) {
        break;
      }
    }
    return result;
  },
};

const projectsSchema: Schema<Record<string, ProjectMeta>> = {
  kind: 'projects',
  validate(value, path, issues) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ path, message: 'expected an object of projects' });
      return undefined;
    }
    const result: Record<string, ProjectMeta> = {};
    let kept = 0;
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const parsed = projectMetaSchema.validate(raw, `${path}.${key}`, issues);
      if (parsed === undefined) {
        continue;
      }
      result[key] = { ...parsed, id: key };
      kept += 1;
      if (kept >= MAX_PROJECTS) {
        break;
      }
    }
    return result;
  },
};

/** Full database schema, used for imports and for files found on disk. */
export const databaseSchema: Schema<DatabaseData> = objectSchema<DatabaseData>({
  meta: metaSchema,
  days: daysSchema,
  sessions: arraySchema(sessionSchema, MAX_SESSIONS),
  projects: projectsSchema,
});

/* ------------------------------ normalization ----------------------------- */

/** Result of normalizing a database. */
export interface NormalizeResult {
  data: DatabaseData;
  issues: ValidationIssue[];
  /** `true` when values had to be repaired (written back on next flush). */
  repaired: boolean;
}

/**
 * Validates and repairs a database object.
 *
 * Never throws: a corrupt or partial file yields a usable database plus the
 * issues that were found, so the user can still open the dashboard and export
 * whatever survived.
 */
export function normalizeDatabase(value: unknown, now = Date.now(), defaultRetentionDays = 365): NormalizeResult {
  const issues: ValidationIssue[] = [];
  const parsed = databaseSchema.validate(value, '$', issues);
  if (parsed === undefined) {
    return { data: emptyDatabase(now, defaultRetentionDays), issues, repaired: true };
  }

  const rawMeta = parsed.meta ?? ({} as Partial<DatabaseMeta>);
  const meta: DatabaseMeta = {
    ...rawMeta,
    schemaVersion: DB_SCHEMA_VERSION,
    createdAt: typeof rawMeta.createdAt === 'number' && rawMeta.createdAt > 0 ? rawMeta.createdAt : now,
    updatedAt: now,
    retentionDays: rawMeta.retentionDays || defaultRetentionDays,
    privacySalt: typeof rawMeta.privacySalt === 'string' ? rawMeta.privacySalt : '',
    onboarded: rawMeta.onboarded === true,
  };

  const days: Record<string, DayStats> = {};
  for (const [key, day] of Object.entries(parsed.days ?? {})) {
    const base = createDayStats(key);
    const merged: DayStats = {
      ...base,
      ...day,
      date: key,
      languages: { ...(day.languages ?? {}) },
      projects: { ...(day.projects ?? {}) },
      hourly: Array.isArray(day.hourly) && day.hourly.length === 24 ? day.hourly : base.hourly,
      activeTime: Number.isFinite(day.activeTime) ? Math.max(0, day.activeTime) : 0,
      sessions: Number.isFinite(day.sessions) ? Math.max(0, Math.round(day.sessions)) : 0,
      filesModified: Number.isFinite(day.filesModified) ? Math.max(0, Math.round(day.filesModified)) : 0,
      filesSaved: Number.isFinite(day.filesSaved) ? Math.max(0, Math.round(day.filesSaved)) : 0,
      filesOpened: Number.isFinite(day.filesOpened) ? Math.max(0, Math.round(day.filesOpened)) : 0,
      longestSession: Number.isFinite(day.longestSession) ? Math.max(0, day.longestSession) : 0,
    };
    if (
      typeof merged.firstActivity === 'number' &&
      typeof merged.lastActivity === 'number' &&
      merged.lastActivity < merged.firstActivity
    ) {
      merged.lastActivity = merged.firstActivity;
    }
    // Active time can never exceed the session count times the day length.
    merged.activeTime = Math.min(merged.activeTime, MAX_MS_PER_DAY);
    days[key] = merged;
  }

  const sessions = [...(parsed.sessions ?? [])]
    .filter((session) => session.endTime >= session.startTime)
    .sort((a, b) => a.startTime - b.startTime);

  const projects: Record<string, ProjectMeta> = {};
  for (const [id, project] of Object.entries(parsed.projects ?? {})) {
    const name = sanitizeProjectName(project.name);
    projects[id] = { id, name, firstSeen: project.firstSeen, lastSeen: project.lastSeen };
  }

  return {
    data: { meta, days, sessions, projects },
    issues,
    repaired: issues.length > 0,
  };
}

/** A brand new database with fresh metadata. */
export function emptyDatabase(now = Date.now(), retentionDays = 365): DatabaseData {
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

/* --------------------------------- messages ------------------------------- */

/** Validates a stored session record before it is written back. */
export function sanitizeSession(value: unknown): CodingSession | undefined {
  const issues: ValidationIssue[] = [];
  const parsed = sessionSchema.validate(value, '$', issues);
  if (parsed === undefined) {
    return undefined;
  }
  const language = parsed.language ? sanitizeLanguageId(parsed.language) : undefined;
  const projectName = parsed.projectName ? sanitizeProjectName(parsed.projectName) : undefined;
  const session: CodingSession = {
    id: parsed.id,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    duration: Math.min(parsed.duration, MAX_MS_PER_DAY),
  };
  if (language) {
    session.language = language;
  }
  if (parsed.project) {
    session.project = parsed.project;
  }
  if (projectName) {
    session.projectName = projectName;
  }
  return session;
}

/** Validates the hourly histogram of a delta (always 24 buckets, clamped). */
export function sanitizeHourly(value: unknown): number[] {
  const issues: ValidationIssue[] = [];
  const parsed = hourlySchema.validate(value, '$.hourly', issues);
  return parsed ?? new Array<number>(24).fill(0);
}

/** Validates a counters map (languages or projects). */
export function sanitizeCounts(
  value: unknown,
  options: { maxEntries: number; maxValue: number } = { maxEntries: 500, maxValue: MAX_MS_PER_DAY }
): Record<string, number> {
  const issues: ValidationIssue[] = [];
  const parsed = countMapSchema(options).validate(value, '$.counts', issues);
  return parsed ?? {};
}

/** Validates the current activity timeout option. */
export function isValidInactivityTimeout(value: number): boolean {
  return INACTIVITY_TIMEOUT_OPTIONS.includes(value as (typeof INACTIVITY_TIMEOUT_OPTIONS)[number]);
}

/** Validates the minimum active time option. */
export function isValidMinimumActiveTime(value: number): boolean {
  return MINIMUM_ACTIVE_TIME_OPTIONS.includes(value as (typeof MINIMUM_ACTIVE_TIME_OPTIONS)[number]);
}
