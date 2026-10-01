/**
 * Core statistics model.
 *
 * These types describe what Dev Wrapped stores on disk. They are intentionally
 * free of any VS Code dependency so they can be unit tested with plain Node.
 *
 * Privacy: nothing here can hold source code, file contents or file names.
 * The finest granularity is "a language had N milliseconds of activity" and
 * "a project (identified by a salted hash) had N milliseconds of activity".
 */

/** Milliseconds. Named so the unit of every number is obvious at the call site. */
export type Milliseconds = number;

/** Local date key, always `YYYY-MM-DD` (never UTC). */
export type DateKey = string;

/** Local month key, always `YYYY-MM`. */
export type MonthKey = string;

/** Active time per language id (for example `typescript`). */
export type LanguageTotals = Record<string, Milliseconds>;

/** Active time per anonymized project id. */
export type ProjectTotals = Record<string, Milliseconds>;/**
 * A single stretch of focused coding.
 *
 * `duration` is *active* time: idle stretches are removed when the session is
 * split, so `duration` may be smaller than `endTime - startTime`.
 */
export interface CodingSession {
  id: string;
  startTime: number;
  endTime: number;
  duration: Milliseconds;
  /** Sanitized VS Code language id, for example `typescript`. */
  language?: string;
  /** Anonymized project id (salted hash); never a file system path. */
  project?: string;
  /** Human readable project name (folder name), disabled by `trackProjects`. */
  projectName?: string;
}

/**
 * Everything Dev Wrapped knows about one local day.
 *
 * Day records are the permanent part of the database: they stay forever even
 * after raw sessions are pruned by the retention policy.
 */
export interface DayStats {
  /** Local `YYYY-MM-DD`. */
  date: DateKey;
  /** Active (non idle) time in milliseconds. */
  activeTime: Milliseconds;
  /** Number of sessions that contributed to this day. */
  sessions: number;
  languages: LanguageTotals;
  projects: ProjectTotals;
  /** Documents edited (a save or first edit counts once per document). */
  filesModified: number;
  /** Explicit saves. */
  filesSaved: number;
  /** Documents opened (first open per document per day). */
  filesOpened: number;
  /** Epoch ms of the first recorded activity of the day. */
  firstActivity?: number;
  /** Epoch ms of the last recorded activity of the day. */
  lastActivity?: number;
  /** Duration of the longest session of the day. */
  longestSession: Milliseconds;
  /** Active milliseconds per local hour (24 entries). */
  hourly: number[];
}

/** Known project metadata; the name is the workspace folder name, nothing else. */
export interface ProjectMeta {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
}

/** Database level bookkeeping. */
export interface DatabaseMeta {
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
  /** Days of raw session history that are kept. */
  retentionDays: number;
  /** Random salt used to anonymize project ids; regenerated on reset. */
  privacySalt: string;
  /** `true` after the welcome flow ran (tracking never starts silently). */
  onboarded: boolean;
  /** Last year for which the yearly retrospective was opened. */
  lastWrappedYear?: number;
  /** Set while the user paused tracking. */
  pausedUntil?: number;
}

/** The complete on-disk database. */
export interface DatabaseData {
  meta: DatabaseMeta;
  /** Keyed by local date; permanent. */
  days: Record<DateKey, DayStats>;
  /** Raw sessions; pruned by the retention policy. */
  sessions: CodingSession[];
  /** Project id -> name; never contains a path. */
  projects: Record<string, ProjectMeta>;
}

/** Schema version of the on-disk database (`devwrapped-data.json`). */
export const DB_SCHEMA_VERSION = 2 as const;

/** An empty day record, used as the merge target. */
export function createDayStats(date: DateKey): DayStats {
  return {
    date,
    activeTime: 0,
    sessions: 0,
    languages: {},
    projects: {},
    filesModified: 0,
    filesSaved: 0,
    filesOpened: 0,
    longestSession: 0,
    hourly: new Array<number>(24).fill(0),
  };
}