/**
 * Idle detection.
 *
 * The detector answers one question: "how long has the user been quiet?".
 * It never reads keystrokes or cursor positions — activity is inferred from
 * editor events plus the configured inactivity timeout. When the timeout is
 * reached the detector notifies once and stays quiet until activity resumes.
 *
 * The check runs on a slow timer (default 30 s), which is accurate enough for
 * timeouts measured in minutes and costs nothing while the user works.
 */

export interface IdleDetectorOptions {
  /** Current timeout in milliseconds (read on every check). */
  timeoutMs: () => number;
  /** Called once per idle period, when the timeout is reached. */
  onIdle: (idleMs: number, idleSince: number) => void;
  /** Called when activity resumes after an idle period. */
  onResume?: (idleMs: number) => void;
  /** How often the detector checks (default 30 s). */
  checkIntervalMs?: number;
  /** Injected clock, for tests. */
  now?: () => number;
  /** Injected timer factory, for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export class IdleDetector {
  private readonly options: IdleDetectorOptions;
  private readonly now: () => number;
  private handle: ReturnType<typeof setInterval> | undefined;
  private lastActivity: number;
  private idleNotified = false;

  public constructor(options: IdleDetectorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.lastActivity = this.now();
  }

  /** Begins watching for inactivity. */
  public start(at = this.now()): void {
    this.lastActivity = at;
    this.idleNotified = false;
    if (this.handle !== undefined) {
      return;
    }
    const interval = this.options.checkIntervalMs ?? 30_000;
    const setIntervalFn = this.options.setIntervalFn ?? setInterval;
    this.handle = setIntervalFn(() => this.check(), interval);
    (this.handle as unknown as { unref?: () => void }).unref?.();
  }

  /** Stops watching; call `start` to resume. */
  public stop(): void {
    if (this.handle === undefined) {
      return;
    }
    const clearIntervalFn = this.options.clearIntervalFn ?? clearInterval;
    clearIntervalFn(this.handle);
    this.handle = undefined;
  }

  /** Records that activity happened at `at` (called for every editor event). */
  public touch(at = this.now()): number {
    const wasIdle = this.idleNotified;
    const idleMs = Math.max(0, at - this.lastActivity);
    this.lastActivity = at;
    this.idleNotified = false;
    if (wasIdle) {
      this.options.onResume?.(idleMs);
    }
    return idleMs;
  }

  /** Idle milliseconds right now. */
  public get idleMs(): number {
    return Math.max(0, this.now() - this.lastActivity);
  }

  /** Timestamp of the last observed activity. */
  public get lastActivityAt(): number {
    return this.lastActivity;
  }

  /** `true` once the configured timeout has elapsed without activity. */
  public get isIdle(): boolean {
    return this.idleMs >= this.timeoutMs();
  }

  /** Current timeout in milliseconds. */
  public get timeoutMs(): () => number {
    return this.options.timeoutMs;
  }

  /** Runs the timeout check; called by the internal timer. */
  public check(): void {
    if (this.idleNotified) {
      return;
    }
    const idleMs = this.idleMs;
    if (idleMs >= this.timeoutMs()) {
      this.idleNotified = true;
      this.options.onIdle(idleMs, this.lastActivity);
    }
  }

  /** `true` when the idle callback has already fired for this period. */
  public get hasNotifiedIdle(): boolean {
    return this.idleNotified;
  }

  /** Stops the detector and marks it as cleanly shut down. */
  public dispose(): void {
    this.stop();
  }
}
