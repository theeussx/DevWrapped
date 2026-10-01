/**
 * Small asynchronous helpers (no dependencies, no unhandled rejections).
 */

/** Waits for `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never keep the extension host alive just for a timer.
    timer.unref?.();
  });
}

/**
 * Serializes asynchronous work: two calls to `run` never overlap, and the
 * order of the calls is preserved. Used by the storage layer so concurrent
 * flushes from several windows cannot interleave their writes.
 */
export class TaskQueue {
  private tail: Promise<unknown> = Promise.resolve();

  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Resolves when every queued task has settled. */
  public async drain(): Promise<void> {
    await this.tail;
  }
}

/** Retries an operation a few times with a small backoff. */
export async function retry<T>(
  operation: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 50
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await delay(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** `true` when the rejection carries the given filesystem error code. */
export function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
