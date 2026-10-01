/**
 * Minimal typed event emitter.
 *
 * A handful of listeners inside one extension host does not justify a
 * dependency: this is a small, allocation free replacement for the VS Code
 * `EventEmitter` on the non-VS-Code side of the code base.
 */

export type Listener<T> = (value: T) => void;

/** Function that removes a previously registered listener. */
export type Unsubscribe = () => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  /** Registers a listener and returns the unsubscribe function. */
  public event(listener: Listener<T>): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Registers a listener that is removed after its first event. */
  public once(listener: Listener<T>): Unsubscribe {
    const unsubscribe = this.event((value) => {
      unsubscribe();
      listener(value);
    });
    return unsubscribe;
  }

  /** Notifies every listener; a throwing listener never blocks the others. */
  public fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // Listeners are independent: one failure must not stop the others.
      }
    }
  }

  /** Number of registered listeners (used by tests). */
  public get size(): number {
    return this.listeners.size;
  }

  /** Removes every listener. */
  public clear(): void {
    this.listeners.clear();
  }

  /** Alias kept for symmetry with VS Code disposables. */
  public dispose(): void {
    this.clear();
  }
}

/** Runs a set of disposables in reverse order, never throwing. */
export function disposeAll(disposables: Array<{ dispose(): void }>): void {
  for (const disposable of [...disposables].reverse()) {
    try {
      disposable.dispose();
    } catch {
      // Disposal is best effort.
    }
  }
  disposables.length = 0;
}
