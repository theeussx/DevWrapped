/**
 * The heart of the extension: turns editor events into statistics.
 *
 * The tracker is deliberately decoupled from VS Code (`ActivitySource` is an
 * interface), which keeps the whole model testable with plain Node and makes
 * it impossible for this module to read document text: an `ActivityEvent`
 * carries a language id, an opaque document key and an optional project id —
 * never a file name, never a path, never content.
 *
 * Counting rules
 *  - only active time is recorded: the tracker samples the editor state every
 *    `TICK_MS` (15 s) and counts a tick when the state changed since the last
 *    tick, when an explicit event arrived, or when the window is focused;
 *  - a tick is never counted twice (the reported duration is the time since the
 *    previous tick);
 *  - when no activity is observed for `inactivityTimeout` minutes the session
 *    ends and the idle stretch is discarded;
 *  - pausing is explicit and survives until the user resumes.
 */

import {
  addSessionToDelta,
  createDatabaseDelta,
  emptyLiveContribution,
  isDatabaseDeltaEmpty,
  type DatabaseDelta,
  type DayDelta,
  type LiveContribution,
} from '../types/delta';
import type { CodingSession, DateKey } from '../types/statistics';
import type { TrackingStatus, WrappedSettings } from '../types/config';
import type { Logger } from '../utils/log';
import { dateKey } from '../utils/time';
import { IdleDetector } from './IdleDetector';
import { SessionManager, type SessionContext } from './SessionManager';

/** How often the tracker samples the editor state. */
export const TICK_MS = 15_000;

/** Longest single tick counted as active time (protects against suspend). */
export const MAX_TICK_MS = TICK_MS * 2;

/** Maximum number of unique documents remembered per day (per counter). */
const MAX_DOCUMENT_KEYS = 20_000;

export type ActivityEventKind =
  | 'editorActivated'
  | 'documentChanged'
  | 'documentSaved'
  | 'documentOpened'
  | 'documentCreated'
  | 'workspaceChanged'
  | 'focusChanged';

export interface ActivityEvent {
  kind: ActivityEventKind;
  /** Epoch ms of the event. */
  at: number;
  /** Sanitized VS Code language id. */
  language?: string;
  /** Salted project id (never a path). */
  projectId?: string;
  /** Sanitized folder name (never a path). */
  projectName?: string;
  /** Opaque per-document key used only for de-duplication in memory. */
  documentKey?: string;
  /** `false` when the window lost focus. */
  focused?: boolean;
}

/** Snapshot of the document the user is looking at. */
export interface DocumentSnapshot {
  documentKey?: string;
  language?: string;
  projectId?: string;
  projectName?: string;
}

/** Everything the tracker needs from its environment. */
export interface ActivitySource {
  /** Starts emitting events; the returned function removes every listener. */
  listen(handler: (event: ActivityEvent) => void): () => void;
  /** Document currently in the foreground, if any. */
  currentDocument(): DocumentSnapshot | undefined;
  /** `true` when a VS Code window is focused. */
  isFocused(): boolean;
  /**
   * Cheap value that changes whenever the editor state changes.
   *
   * Used only for change detection inside the extension host; it is never
   * stored, logged or sent anywhere.
   */
  stateSnapshot(): string;
}

export interface ActivityTrackerOptions {
  source: ActivitySource;
  /** Reads the current settings on demand. */
  settings: () => WrappedSettings;
  /** Receives additive deltas; the storage layer merges them. */
  onDelta: (delta: DatabaseDelta) => void;
  /** Called when the tracking state or the current session changed. */
  onStateChange?: () => void;
  /** Called when a session ends, with a short summary for logging. */
  onSessionEnded?: (summary: { startTime: number; endTime: number; activeMs: number }) => void;
  logger?: Logger;
  /** Injected clock, for tests. */
  now?: () => number;
  /** Injected timer factory, for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export class ActivityTracker {
  private readonly options: ActivityTrackerOptions;
  private readonly now: () => number;
  private readonly sessions: SessionManager;
  private readonly idle: IdleDetector;
  private disposeListeners: (() => void) | undefined;
  private tickHandle: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  private pauseReason: 'user' | 'disabled' | undefined;
  private started = false;
  private lastTickAt: number;
  private lastSnapshot = '';
  private pendingEvent = false;
  private lastContext: DocumentSnapshot = {};
  /** Document keys already counted today, per counter. */
  private counted: { day: DateKey; modified: Set<string>; saved: Set<string>; opened: Set<string> };

  public constructor(options: ActivityTrackerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.lastTickAt = this.now();
    this.counted = {
      day: dateKey(this.now()),
      modified: new Set(),
      saved: new Set(),
      opened: new Set(),
    };
    this.sessions = new SessionManager({
      inactivityTimeoutMs: () => this.timeoutMs(),
      trackLanguages: () => this.options.settings().trackLanguages,
      trackProjects: () => this.options.settings().trackProjects,
      now: this.now,
    });
    this.idle = new IdleDetector({
      timeoutMs: () => this.timeoutMs(),
      onIdle: (idleMs, idleSince) => this.handleIdle(idleMs, idleSince),
      onResume: (idleMs) => {
        this.options.logger?.debug(`Activity resumed after ${Math.round(idleMs / 1000)}s idle.`);
      },
      now: this.now,
      ...(options.setIntervalFn ? { setIntervalFn: options.setIntervalFn } : {}),
      ...(options.clearIntervalFn ? { clearIntervalFn: options.clearIntervalFn } : {}),
    });
  }

  /* ------------------------------ public API ------------------------------ */

  /** Attaches listeners and the sampling timer. Safe to call twice. */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.disposeListeners = this.options.source.listen((event) => this.handleEvent(event));
    this.idle.start(this.now());
    const setIntervalFn = this.options.setIntervalFn ?? setInterval;
    this.tickHandle = setIntervalFn(() => this.tick(), TICK_MS);
    (this.tickHandle as unknown as { unref?: () => void }).unref?.();
    this.lastTickAt = this.now();
    this.lastSnapshot = this.safeSnapshot();
    this.options.logger?.info('Activity tracking started.');
    this.emitStateChange();
  }

  /** Detaches listeners and stops the timers. */
  public stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.disposeListeners?.();
    this.disposeListeners = undefined;
    if (this.tickHandle !== undefined) {
      const clearIntervalFn = this.options.clearIntervalFn ?? clearInterval;
      clearIntervalFn(this.tickHandle);
      this.tickHandle = undefined;
    }
    this.idle.stop();
  }

  /** Pauses tracking explicitly (the pause survives until `resume`). */
  public pause(reason: 'user' | 'disabled' = 'user'): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    this.pauseReason = reason;
    const ended = this.sessions.end('pause');
    if (ended) {
      this.queueSession(ended.session, ended.dayKey);
    }
    this.idle.stop();
    this.options.logger?.info(reason === 'user' ? 'Tracking paused by the user.' : 'Tracking paused.');
    this.flush();
    this.emitStateChange();
  }

  /** Resumes tracking after an explicit pause. */
  public resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.pauseReason = undefined;
    this.idle.start(this.now());
    this.lastTickAt = this.now();
    this.lastSnapshot = this.safeSnapshot();
    this.options.logger?.info('Tracking resumed.');
    this.emitStateChange();
  }

  /** Re-reads the settings (timeout, languages, projects). */
  public applySettings(): void {
    const settings = this.options.settings();
    if (!settings.trackLanguages) {
      this.lastContext = { ...this.lastContext, language: undefined };
    }
    if (!settings.trackProjects) {
      this.lastContext = { ...this.lastContext, projectId: undefined, projectName: undefined };
    }
    if (this.sessions.isActive && this.idle.isIdle) {
      // The timeout was shortened below the current idle time.
      this.handleIdle(this.idle.idleMs, this.idle.lastActivityAt);
    }
    this.emitStateChange();
  }

  /** Handles one editor event. */
  public handleEvent(event: ActivityEvent): void {
    const at = Number.isFinite(event.at) ? event.at : this.now();
    if (this.paused) {
      return;
    }
    if (event.kind === 'focusChanged' && event.focused === false) {
      // Losing focus is not activity, and it is not an immediate session end:
      // the idle timeout decides.
      this.lastSnapshot = '';
      return;
    }
    this.idle.touch(at);
    this.pendingEvent = true;

    const context: SessionContext = {};
    if (event.language) {
      context.language = event.language;
    }
    if (event.projectId) {
      context.projectId = event.projectId;
      if (event.projectName) {
        context.projectName = event.projectName;
      }
    }
    if (event.language || event.projectId) {
      this.lastContext = {
        ...(event.language ? { language: event.language } : this.lastContext.language ? { language: this.lastContext.language } : {}),
        ...(event.projectId ? { projectId: event.projectId } : {}),
        ...(event.projectName ? { projectName: event.projectName } : {}),
      };
    }
    if (event.documentKey) {
      this.lastContext = { ...this.lastContext, documentKey: event.documentKey };
    }

    this.sessions.start(context);

    switch (event.kind) {
      case 'documentChanged':
        this.countFile('modified', event.documentKey, at);
        break;
      case 'documentSaved':
        this.countFile('saved', event.documentKey, at);
        this.countFile('modified', event.documentKey, at);
        break;
      case 'documentOpened':
        this.countFile('opened', event.documentKey, at);
        break;
      case 'documentCreated':
        this.countFile('modified', event.documentKey, at);
        break;
      default:
        break;
    }
  }

  /**
   * Samples the editor state.
   *
   * Called on a timer: the elapsed time since the previous tick is credited as
   * active time only when something changed or an event arrived, and it is
   * capped so a suspended machine cannot book hours of "work".
   */
  public tick(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;

    if (this.paused) {
      this.pendingEvent = false;
      return;
    }

    const snapshot = this.safeSnapshot();
    const changed = snapshot !== this.lastSnapshot;
    const eventSeen = this.pendingEvent;
    this.pendingEvent = false;

    const focused = this.safeFocused();
    const active = (changed && focused) || (eventSeen && focused);

    if (active) {
      const document = this.safeCurrentDocument();
      const context: SessionContext = {};
      if (document?.language) {
        context.language = document.language;
      }
      if (document?.projectId) {
        context.projectId = document.projectId;
        if (document.projectName) {
          context.projectName = document.projectName;
        }
      }
      this.sessions.start(context);
      this.rolloverIfNeeded();
      this.lastContext = { ...this.lastContext, ...document };
      this.sessions.recordActive(Math.min(elapsed, MAX_TICK_MS), now, this.lastContext);
      this.idle.touch(now);
      this.flush();
      this.emitStateChange();
    } else if (this.sessions.isActive) {
      this.idle.check();
    }

    this.lastSnapshot = snapshot;
  }

  /** Writes the accumulated contribution to storage (additive delta). */
  public flush(): void {
    const delta = createDatabaseDelta();
    for (const day of this.sessions.takeDeltas()) {
      delta.days[day.date] = mergeDay(delta.days[day.date], day);
    }
    for (const session of this.pendingSessions.splice(0)) {
      addSessionToDelta(delta, session.session, session.dayKey);
    }
    if (isDatabaseDeltaEmpty(delta)) {
      return;
    }
    try {
      this.options.onDelta(delta);
    } catch (error) {
      // Put the data back so a storage hiccup cannot lose activity.
      this.sessions.restore(Object.values(delta.days));
      this.pendingSessions.unshift(...delta.sessions.map((session) => ({ session, dayKey: dateKey(session.startTime) })));
      this.options.logger?.error('Could not record activity.', (error as Error).message);
    }
  }

  /** Current status, used by the dashboard and the status bar. */
  public status(): TrackingStatus {
    const session = this.sessions.summary();
    const status: TrackingStatus = {
      state: this.paused ? 'paused' : this.sessions.isActive ? 'tracking' : 'idle',
      sessionActiveTime: this.sessions.activeMs,
      idleTime: this.sessions.isActive ? this.sessions.idleMs : 0,
    };
    if (this.paused && this.pauseReason) {
      status.reason = this.pauseReason;
    } else if (!this.paused && this.idle.hasNotifiedIdle) {
      status.reason = 'idle';
    }
    if (session) {
      status.sessionStart = session.startTime;
      if (session.language) {
        status.language = session.language;
      }
      if (session.projectName) {
        status.projectName = session.projectName;
      }
    }
    return status;
  }

  /** `true` while the user has paused tracking explicitly. */
  public get isPaused(): boolean {
    return this.paused;
  }

  /** `true` while a session is in progress. */
  public get isSessionActive(): boolean {
    return this.sessions.isActive;
  }

  /** The not-yet-flushed contribution of the current day (for the dashboard). */
  public liveContribution(): LiveContribution | undefined {
    const pending = this.sessions.liveFor(dateKey(this.now()));
    if (!pending) {
      return undefined;
    }
    const live: LiveContribution = {
      date: pending.date,
      ms: pending.ms,
      languages: { ...pending.languages },
      projects: { ...pending.projects },
      projectNames: { ...pending.projectNames },
      filesModified: pending.filesModified,
      filesSaved: pending.filesSaved,
      filesOpened: pending.filesOpened,
      longestSession: pending.longestSession,
      hourly: [...pending.hourly],
      sessions: pending.sessions,
    };
    if (pending.firstActivity !== undefined) {
      live.firstActivity = pending.firstActivity;
    }
    if (pending.lastActivity !== undefined) {
      live.lastActivity = pending.lastActivity;
    }
    return live;
  }

  /** Detaches everything; the tracker cannot be restarted afterwards. */
  public dispose(): void {
    this.stop();
    this.flush();
    this.sessions.cancel();
  }

  /* -------------------------------- private ------------------------------- */

  private readonly pendingSessions: Array<{ session: CodingSession; dayKey: DateKey }> = [];

  /** Timeout in milliseconds, read from the settings on every use. */
  private timeoutMs(): number {
    const minutes = this.options.settings().inactivityTimeout;
    return Math.max(1, minutes) * 60_000;
  }

  private handleIdle(idleMs: number, idleSince: number): void {
    const ended = this.sessions.end('timeout', idleSince);
    if (ended) {
      this.queueSession(ended.session, ended.dayKey);
      this.options.logger?.debug(
        `Session ended after ${Math.round(idleMs / 1000)}s without activity (${Math.round(ended.session.duration / 60000)} active minutes).`
      );
      this.options.onSessionEnded?.({
        startTime: ended.session.startTime,
        endTime: ended.session.endTime,
        activeMs: ended.session.duration,
      });
    }
    this.flush();
    this.emitStateChange();
  }

  private queueSession(session: CodingSession, dayKey: DateKey): void {
    if (this.pendingSessions.length > 100) {
      this.pendingSessions.shift();
    }
    this.pendingSessions.push({ session, dayKey });
  }

  private countFile(kind: 'modified' | 'saved' | 'opened', documentKey: string | undefined, at: number): void {
    if (!documentKey) {
      return;
    }
    const day = dateKey(at);
    if (this.counted.day !== day) {
      this.counted = { day, modified: new Set(), saved: new Set(), opened: new Set() };
    }
    const set = this.counted[kind];
    if (set.size >= MAX_DOCUMENT_KEYS || set.has(documentKey)) {
      return;
    }
    set.add(documentKey);
    this.sessions.recordFile(kind, at);
  }

  /** Flushes the previous day when the local date changed while tracking. */
  private rolloverIfNeeded(): void {
    const today = dateKey(this.now());
    if (this.counted.day !== today) {
      this.counted = { day: today, modified: new Set(), saved: new Set(), opened: new Set() };
      this.flush();
    }
  }

  private safeSnapshot(): string {
    try {
      return this.options.source.stateSnapshot();
    } catch {
      return '';
    }
  }

  private safeFocused(): boolean {
    try {
      return this.options.source.isFocused();
    } catch {
      return true;
    }
  }

  private safeCurrentDocument(): DocumentSnapshot | undefined {
    try {
      return this.options.source.currentDocument();
    } catch {
      return undefined;
    }
  }

  private emitStateChange(): void {
    try {
      this.options.onStateChange?.();
    } catch {
      // Listeners are independent.
    }
  }
}

/** Merges two day deltas without losing information. */
function mergeDay(target: DayDelta | undefined, part: DayDelta): DayDelta {
  if (!target) {
    return part;
  }
  target.ms += part.ms;
  target.sessions += part.sessions;
  target.filesModified += part.filesModified;
  target.filesSaved += part.filesSaved;
  target.filesOpened += part.filesOpened;
  target.longestSession = Math.max(target.longestSession, part.longestSession);
  for (const [language, ms] of Object.entries(part.languages)) {
    target.languages[language] = (target.languages[language] ?? 0) + ms;
  }
  for (const [project, ms] of Object.entries(part.projects)) {
    target.projects[project] = (target.projects[project] ?? 0) + ms;
  }
  for (let hour = 0; hour < 24; hour += 1) {
    target.hourly[hour] = (target.hourly[hour] ?? 0) + (part.hourly[hour] ?? 0);
  }
  if (part.firstActivity !== undefined) {
    target.firstActivity =
      target.firstActivity === undefined ? part.firstActivity : Math.min(target.firstActivity, part.firstActivity);
  }
  if (part.lastActivity !== undefined) {
    target.lastActivity =
      target.lastActivity === undefined ? part.lastActivity : Math.max(target.lastActivity, part.lastActivity);
  }
  return target;
}

/** Empty day delta helper re-exported for tests. */
export { emptyLiveContribution };
