/**
 * Settings and activity detection model.
 *
 * The option sets are part of the public contract of the extension: the
 * settings UI only offers the documented values, and the values are validated
 * again on every read so a hand edited `settings.json` can never put the
 * tracker into an undefined state.
 */

/** Minutes before a coding session is considered finished. */
export const INACTIVITY_TIMEOUT_OPTIONS = [5, 10, 15, 30] as const;
export type InactivityTimeout = (typeof INACTIVITY_TIMEOUT_OPTIONS)[number];

/** Minutes of active work a day needs before it counts towards a streak. */
export const MINIMUM_ACTIVE_TIME_OPTIONS = [10, 30, 60] as const;
export type MinimumActiveTime = (typeof MINIMUM_ACTIVE_TIME_OPTIONS)[number];

/** How long raw sessions are kept; daily aggregates are always kept. */
export const SESSION_RETENTION_OPTIONS = [90, 365, 1095] as const;
export type SessionRetentionDays = (typeof SESSION_RETENTION_OPTIONS)[number];

/** All user facing settings, mirrored 1:1 by the `codeWrapped.*` keys. */
export interface WrappedSettings {
  /** Minutes of inactivity after which the current session ends. */
  inactivityTimeout: InactivityTimeout;
  /** Minutes of active work that make a day count for streaks. */
  minimumActiveTime: MinimumActiveTime;
  /** Record per-language statistics. */
  trackLanguages: boolean;
  /** Record per-project statistics (folder names, never paths). */
  trackProjects: boolean;
  /** Show weekly summaries and the yearly retrospective notifications. */
  enableNotifications: boolean;
  /** Verbose logging in the "Code Wrapped" output channel. */
  debugLogging: boolean;
  /** Show today's active time in the status bar. */
  showStatusBar: boolean;
  /** Days of raw session history to keep. */
  sessionRetentionDays: SessionRetentionDays;
}

export const DEFAULT_SETTINGS: WrappedSettings = {
  inactivityTimeout: 10,
  minimumActiveTime: 30,
  trackLanguages: true,
  trackProjects: true,
  enableNotifications: false,
  debugLogging: false,
  showStatusBar: true,
  sessionRetentionDays: 365,
};

/** High level state of the activity tracker. */
export type TrackingState = 'idle' | 'tracking' | 'paused';

/** Snapshot of the tracker, used by the status bar and the dashboards. */
export interface TrackingStatus {
  state: TrackingState;
  reason?: 'user' | 'idle' | 'disabled';
  sessionStart?: number;
  /** Active milliseconds accumulated in the current session. */
  sessionActiveTime: number;
  /** Idle milliseconds since the last recorded activity. */
  idleTime: number;
  /** The document the tracker considers active, for display only. */
  language?: string;
  projectName?: string;
}

/** One entry of the activity log shown in the dashboard. */
export interface ActivityEventView {
  at: number;
  kind: string;
  detail?: string;
}

/** Values shown in the status bar tooltip and on the Privacy page. */
export interface StatusPayload {
  tracking: {
    enabled: boolean;
    paused: boolean;
    reason?: string;
    /** `true` while a coding session is in progress. */
    sessionActive: boolean;
    sessionStart?: number;
    sessionActiveTime: number;
    todayActiveTime: number;
    idleTimeoutMinutes: number;
    minimumActiveTimeMinutes: number;
  };
  currentStreak: number;
  version: string;
}

/** Folds an arbitrary value into one of the documented options. */
export function snapToOption<T extends number>(value: unknown, options: readonly T[], fallback: T): T {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return options.includes(parsed as T) ? (parsed as T) : fallback;
}
