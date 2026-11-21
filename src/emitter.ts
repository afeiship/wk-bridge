import type { Unsubscribe } from './types';

/** Listener shape used internally; payloads stay `unknown` at this layer. @internal */
export type EmitterListener = (payload: unknown) => void;

/** @internal */
interface ListenerRecord {
  /** Function actually invoked. */
  fn: EmitterListener;
  /** Function supplied by the consumer, used for `off` matching. */
  original: EmitterListener;
  /** Whether the record removes itself before the next dispatch. */
  once: boolean;
}

/**
 * Minimal event emitter with per-listener error isolation.
 *
 * Kept internal so the public bridge can expose schema-typed overloads while
 * storage stays untyped.
 * @internal
 */
export class Emitter {
  private readonly records = new Map<string, Set<ListenerRecord>>();

  /**
   * Adds a persistent listener.
   *
   * @param event - Event name.
   * @param listener - Callback invoked on every dispatch.
   * @returns A function that removes the listener.
   */
  on(event: string, listener: EmitterListener): Unsubscribe {
    return this.add(event, { fn: listener, original: listener, once: false });
  }

  /**
   * Adds a listener that removes itself after the first dispatch.
   *
   * @param event - Event name.
   * @param listener - Callback invoked at most once.
   * @returns A function that removes the listener before it fires.
   */
  once(event: string, listener: EmitterListener): Unsubscribe {
    const record: ListenerRecord = {
      fn: (payload) => {
        this.remove(event, record);
        listener(payload);
      },
      original: listener,
      once: true
    };
    return this.add(event, record);
  }

  /**
   * Removes a listener registered through `on` or `once`.
   *
   * Accepts either the original function or the internal wrapper, so the
   * unsubscribe function returned by `once` keeps working.
   *
   * @param event - Event name.
   * @param listener - Original listener or internal wrapper.
   */
  off(event: string, listener: EmitterListener): void {
    const set = this.records.get(event);
    if (!set) return;

    for (const record of set) {
      if (record.original === listener || record.fn === listener) {
        set.delete(record);
      }
    }
    if (set.size === 0) {
      this.records.delete(event);
    }
  }

  /**
   * Dispatches a payload to the current listeners.
   *
   * Listener exceptions are reported through `onError` and never stop other
   * listeners. Listeners added during this dispatch run only on the next one.
   *
   * @param event - Event name.
   * @param payload - Value forwarded to listeners.
   * @param onError - Receives listener exceptions.
   * @returns `true` when at least one listener existed.
   */
  emit(event: string, payload: unknown, onError: (error: unknown, event: string) => void): boolean {
    const set = this.records.get(event);
    if (!set || set.size === 0) return false;

    const snapshot = [...set];
    for (const record of snapshot) {
      if (!set.has(record)) continue;
      if (record.once) {
        set.delete(record);
      }
      try {
        record.fn(payload);
      } catch (error) {
        onError(error, event);
      }
    }

    if (set.size === 0) {
      this.records.delete(event);
    }
    return true;
  }

  /**
   * Counts listeners currently registered for an event.
   *
   * @param event - Event name.
   * @returns Number of live listeners.
   */
  count(event: string): number {
    return this.records.get(event)?.size ?? 0;
  }

  /** Removes every listener from every event. */
  clear(): void {
    this.records.clear();
  }

  private add(event: string, record: ListenerRecord): Unsubscribe {
    let set = this.records.get(event);
    if (!set) {
      set = new Set<ListenerRecord>();
      this.records.set(event, set);
    }
    set.add(record);
    return () => {
      this.remove(event, record);
    };
  }

  private remove(event: string, record: ListenerRecord): void {
    const set = this.records.get(event);
    if (!set) return;
    set.delete(record);
    if (set.size === 0) {
      this.records.delete(event);
    }
  }
}
