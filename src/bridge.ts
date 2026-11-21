import {
  DEFAULT_CHANNEL,
  DEFAULT_INBOX_KEY,
  DEFAULT_RECEIVE_KEY,
  DEFAULT_TIMEOUT,
  VERSION
} from './constants';
import { Emitter } from './emitter';
import { BridgeError, ErrorCodes } from './errors';
import { detectTransport } from './transport';
import type {
  Bridge,
  BridgeGlobal,
  BridgeListener,
  BridgeOptions,
  BridgeRequestMessage,
  CallOptions,
  DebugLogger,
  EventMap,
  EventSchema,
  MethodMap,
  MethodSchema,
  NativeTransport,
  Unsubscribe
} from './types';

/** @internal */
interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Narrows an unknown value to a plain JSON object.
 *
 * @param value - Value to check.
 * @returns `true` for non-null, non-array objects.
 * @internal
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the debug logger used across the bridge.
 *
 * @param option - `true`, a custom logger, or `false` / `undefined`.
 * @returns A logger that is a no-op unless debugging is enabled.
 * @internal
 */
function createDebugLogger(option: BridgeOptions['debug']): DebugLogger {
  if (typeof option === 'function') {
    return option;
  }
  if (option === true) {
    return (message, detail) => {
      if (detail === undefined) {
        console.debug(`[wk-bridge] ${message}`);
      } else {
        console.debug(`[wk-bridge] ${message}`, detail);
      }
    };
  }
  return () => {
    /* debugging disabled */
  };
}

/**
 * Creates a bridge instance for a WKWebView-like host.
 *
 * The returned bridge wraps `window.webkit.messageHandlers[channel].postMessage`
 * in a promise-based request/response channel, routes native `event` messages to
 * typed listeners, and installs `window[receiveKey]` so Swift can push messages
 * back with `callAsyncJavaScript`.
 *
 * The bridge has zero dependencies and does not assume a browser: pass `global`
 * and / or `transport` to drive it from a test, SSR context, or another host.
 *
 * @typeParam M - Method schema. Keys become allowed method names; values map to
 *   {@link MethodSpec} param / result types.
 * @typeParam E - Event schema. Keys become subscribed event names.
 * @param options - Channel, timeout, custom transport, global object and debug hooks.
 * @returns A bridge bound to the configured native channel.
 *
 * @example Untyped
 * ```ts
 * import { createBridge } from '@jswork/wk-bridge';
 *
 * const bridge = createBridge({ debug: true });
 * const info = await bridge.call<{ platform: string }>('app.info');
 * bridge.on('theme.changed', ({ theme }: { theme: 'light' | 'dark' }) => {
 *   document.documentElement.dataset.theme = theme;
 * });
 * ```
 *
 * @example Schema-typed
 * ```ts
 * import { createBridge, type MethodSpec } from '@jswork/wk-bridge';
 *
 * interface AppMethods {
 *   'app.info': MethodSpec<void, { platform: string; version: string }>;
 *   'storage.get': MethodSpec<{ key: string }, { value: string }>;
 * }
 * interface AppEvents {
 *   'theme.changed': { theme: 'light' | 'dark' };
 * }
 *
 * const bridge = createBridge<AppMethods, AppEvents>();
 * const info = await bridge.call('app.info'); // { platform: string; version: string }
 * ```
 *
 * @see {@link createMockBridge} for browser-side development without a native host.
 * @public
 */
export function createBridge<
  M extends MethodSchema<M> = MethodMap,
  E extends EventSchema<E> = EventMap
>(options: BridgeOptions = {}): Bridge<M, E> {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const defaultTimeout = options.timeout ?? DEFAULT_TIMEOUT;
  const receiveKey = options.receiveKey ?? DEFAULT_RECEIVE_KEY;
  const inboxKey = options.inboxKey ?? DEFAULT_INBOX_KEY;
  const idPrefix = options.idPrefix ?? 'r';
  const globalObject = options.global ?? (globalThis as unknown as BridgeGlobal);

  const emitter = new Emitter();
  const debug = createDebugLogger(options.debug);
  const pending = new Map<string, PendingCall>();
  const reportListenerError: (error: unknown, event: string) => void =
    options.onListenerError ??
    ((error, event) => {
      console.error(`[wk-bridge] listener for "${event}" threw`, error);
    });

  let transport = options.transport;
  let installedReceiver: Record<string, unknown> | undefined;
  let sequence = 0;
  let destroyed = false;

  /**
   * Resolves the native transport, caching the first successful detection.
   *
   * @returns The transport, or `undefined` when no WKWebView host is present.
   */
  const getTransport = (): NativeTransport | undefined => {
    if (transport) return transport;
    transport = detectTransport(globalObject, channel);
    return transport;
  };

  /**
   * Removes a pending call and clears its timer / abort listener.
   *
   * @param id - Request id.
   * @returns The pending entry, or `undefined` when already settled.
   */
  const finalize = (id: string): PendingCall | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;

    pending.delete(id);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    return entry;
  };

  /**
   * Sends one request and wires timeout / abort handling.
   *
   * @param method - Native method name.
   * @param params - JSON parameters; omitted becomes `{}`.
   * @param callOptions - Per-call timeout and abort signal.
   * @returns A promise resolved by the matching native response.
   */
  const call = (
    method: string,
    params?: unknown,
    callOptions: CallOptions = {}
  ): Promise<unknown> => {
    if (destroyed) {
      return Promise.reject(
        new BridgeError(ErrorCodes.DISPOSED, `Cannot call "${method}" on a destroyed bridge`, {
          method
        })
      );
    }
    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(
        new BridgeError(ErrorCodes.INVALID_METHOD, 'Method name must be a non-empty string')
      );
    }

    const port = getTransport();
    if (!port) {
      return Promise.reject(
        new BridgeError(
          ErrorCodes.UNAVAILABLE,
          `No native transport is available for channel "${channel}"`,
          { method }
        )
      );
    }

    const signal = callOptions.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new BridgeError(ErrorCodes.ABORTED, `Call "${method}" was aborted before it started`, {
          method
        })
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const id = `${idPrefix}${(++sequence).toString(36)}-${Date.now().toString(36)}`;
      const timeout = callOptions.timeout === undefined ? defaultTimeout : callOptions.timeout;
      const entry: PendingCall = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal
      };

      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          const active = finalize(id);
          if (!active) return;
          debug(`timeout: ${method}`, { id, timeout });
          active.reject(
            new BridgeError(
              ErrorCodes.TIMEOUT,
              `Native did not respond to "${method}" within ${timeout}ms`,
              { method }
            )
          );
        }, timeout);
      }

      if (signal) {
        entry.onAbort = () => {
          const active = finalize(id);
          if (!active) return;
          debug(`aborted: ${method}`, { id });
          active.reject(
            new BridgeError(ErrorCodes.ABORTED, `Call "${method}" was aborted`, { method })
          );
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      pending.set(id, entry);

      const message: BridgeRequestMessage = { id, method, params: params ?? {} };
      try {
        port.postMessage(message);
        debug(`→ ${method}`, message);
      } catch (error) {
        finalize(id);
        reject(
          new BridgeError(ErrorCodes.TRANSPORT_ERROR, `Failed to post "${method}" to native`, {
            method,
            cause: error
          })
        );
      }
    });
  };

  /**
   * Resolves a `response` message against its pending call.
   *
   * @param message - Parsed native response.
   */
  const handleResponse = (message: Record<string, unknown>): void => {
    const { id } = message;
    if (typeof id !== 'string' || id.length === 0) {
      debug('receive: response without a valid id');
      return;
    }

    const entry = finalize(id);
    if (!entry) {
      debug('dropped response for an unknown or settled id', id);
      return;
    }

    if (message.ok === true) {
      debug(`← ${entry.method} ok`, { id });
      entry.resolve(message.result);
      return;
    }

    const errorPayload = isRecord(message.error) ? message.error : {};
    const code =
      typeof errorPayload.code === 'string' && errorPayload.code.length > 0
        ? errorPayload.code
        : ErrorCodes.UNKNOWN;
    const text =
      typeof errorPayload.message === 'string' && errorPayload.message.length > 0
        ? errorPayload.message
        : `Native call "${entry.method}" failed`;
    debug(`← ${entry.method} failed`, { id, code });
    entry.reject(
      new BridgeError(code, text, {
        method: entry.method,
        data: errorPayload.data
      })
    );
  };

  /**
   * Dispatches an `event` message to registered listeners.
   *
   * @param message - Parsed native event.
   */
  const handleEvent = (message: Record<string, unknown>): void => {
    const { event } = message;
    if (typeof event !== 'string' || event.length === 0) {
      debug('receive: event without a valid name');
      return;
    }

    const delivered = emitter.emit(event, message.data, reportListenerError);
    if (!delivered) {
      debug(`event "${event}" has no listeners`);
    }
  };

  /**
   * Accepts one native message.
   *
   * Invalid JSON, non-object payloads and unknown types are ignored so one bad
   * message can never break the bridge.
   *
   * @param payload - Parsed message, JSON text, or anything else.
   */
  const receive = (payload: unknown): void => {
    if (destroyed) return;

    let message: unknown = payload;
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch (error) {
        debug('receive: payload is not valid JSON', error);
        return;
      }
    }

    if (!isRecord(message)) {
      debug('receive: payload is not an object');
      return;
    }

    if (message.type === 'response') {
      handleResponse(message);
      return;
    }
    if (message.type === 'event') {
      handleEvent(message);
      return;
    }
    debug('receive: unknown message type', message.type);
  };

  /** @internal */
  const on = (event: string, listener: BridgeListener<unknown>): Unsubscribe => {
    return emitter.on(event, listener);
  };

  /** @internal */
  const once = (event: string, listener: BridgeListener<unknown>): Unsubscribe => {
    return emitter.once(event, listener);
  };

  /** @internal */
  const off = (event: string, listener: BridgeListener<unknown>): void => {
    emitter.off(event, listener);
  };

  /**
   * Installs the global receiver and drains messages queued before boot.
   *
   * Native code can either call `global[receiveKey].receive(payload)` directly
   * or push into `global[inboxKey]` when the receiver is not ready yet.
   */
  const installReceiver = (): void => {
    if (options.installGlobal === false) return;

    const holder = globalObject as Record<string, unknown>;
    if (holder[receiveKey] !== undefined) {
      debug(`receiver key "${receiveKey}" is already set; replacing it`);
    }

    const receiver = { receive, version: VERSION, channel };
    holder[receiveKey] = receiver;
    installedReceiver = receiver;

    const inbox = holder[inboxKey];
    if (Array.isArray(inbox)) {
      if (inbox.length > 0) {
        const queued = inbox.splice(0, inbox.length);
        debug(`draining ${queued.length} queued message(s)`);
        for (const message of queued) {
          receive(message);
        }
      }
    } else if (inbox !== undefined) {
      debug(`"${inboxKey}" is not an array; ignoring`);
    }
  };

  /**
   * Rejects every pending call, clears listeners and removes the global receiver.
   */
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    debug('destroying bridge');

    while (pending.size > 0) {
      const id = pending.keys().next().value as string;
      const entry = finalize(id);
      if (!entry) continue;
      debug(`disposing pending call: ${entry.method}`, { id });
      entry.reject(
        new BridgeError(
          ErrorCodes.DISPOSED,
          `Bridge destroyed while "${entry.method}" was pending`,
          { method: entry.method }
        )
      );
    }

    emitter.clear();

    const holder = globalObject as Record<string, unknown>;
    if (installedReceiver && holder[receiveKey] === installedReceiver) {
      delete holder[receiveKey];
    }
    installedReceiver = undefined;
  };

  const bridge: Bridge<M, E> = {
    channel,
    version: VERSION,
    get available(): boolean {
      return !destroyed && getTransport() !== undefined;
    },
    get pendingCount(): number {
      return pending.size;
    },
    call: call as unknown as Bridge<M, E>['call'],
    on: on as unknown as Bridge<M, E>['on'],
    once: once as unknown as Bridge<M, E>['once'],
    off: off as unknown as Bridge<M, E>['off'],
    receive,
    destroy
  };

  installReceiver();
  return bridge;
}
