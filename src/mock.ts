import { createBridge } from './bridge';
import { BridgeError, ErrorCodes } from './errors';
import type {
  Bridge,
  BridgeFailureMessage,
  BridgeOptions,
  BridgeRequestMessage,
  BridgeResponseMessage,
  EventMap,
  EventSchema,
  MethodMap,
  MethodSchema,
  NativeTransport,
  ParamsOf,
  ResultOf
} from './types';

/**
 * Utilities handed to a mock handler.
 *
 * @typeParam E - Event schema, so `emit` is type-checked.
 * @public
 */
export interface MockContext<E extends EventSchema<E> = EventMap> {
  /**
   * Emits an event as if the native host pushed it.
   *
   * @typeParam K - Event name.
   * @param event - Event name.
   * @param payload - Payload delivered to subscribers.
   */
  emit<K extends keyof E & string>(event: K, payload: E[K]): void;
}

/**
 * One mock implementation. Mirrors a native handler: read params, return a
 * value (or throw a {@link BridgeError} to reject the call).
 *
 * @typeParam M - Method schema.
 * @typeParam K - Method key this handler implements.
 * @typeParam E - Event schema.
 * @public
 */
export type MockHandler<
  M extends MethodSchema<M>,
  K extends keyof M,
  E extends EventSchema<E> = EventMap
> = (params: ParamsOf<M[K]>, context: MockContext<E>) => ResultOf<M[K]> | Promise<ResultOf<M[K]>>;

/**
 * Handler map accepted by {@link createMockBridge}. Every method is optional,
 * so a mock can cover only the calls a screen needs.
 *
 * @typeParam M - Method schema.
 * @typeParam E - Event schema.
 * @public
 */
export type MockHandlers<M extends MethodSchema<M>, E extends EventSchema<E> = EventMap> = {
  [K in keyof M]?: MockHandler<M, K, E>;
};

/**
 * Options accepted by {@link createMockBridge}.
 *
 * Global installation and custom transport are intentionally omitted: a mock
 * never touches `window` and answers through its own in-memory transport.
 * @public
 */
export type MockOptions = Pick<
  BridgeOptions,
  'channel' | 'timeout' | 'debug' | 'idPrefix' | 'onListenerError'
> & {
  /**
   * Simulated native latency in milliseconds, or a `[min, max]` range.
   * @defaultValue `0`
   */
  latency?: number | readonly [min: number, max: number];
};

/**
 * Mock bridge returned by {@link createMockBridge}.
 *
 * @typeParam M - Method schema.
 * @typeParam E - Event schema.
 * @public
 */
export interface MockBridge<
  M extends MethodSchema<M> = MethodMap,
  E extends EventSchema<E> = EventMap
> extends Bridge<M, E> {
  /**
   * Emits an event as if the native host pushed it.
   *
   * @typeParam K - Event name.
   * @param event - Event name.
   * @param payload - Payload delivered to subscribers.
   */
  emit<K extends keyof E & string>(event: K, payload: E[K]): void;

  /** Requests received so far, in call order. Useful for assertions. */
  readonly calls: ReadonlyArray<BridgeRequestMessage>;
}

/**
 * Creates an in-memory bridge for browser development and tests.
 *
 * The returned instance exposes the same API as {@link createBridge}, but
 * requests are answered by local handlers instead of a native host. Nothing is
 * written to `window`, and `available` stays `true` so application code does
 * not need to branch on the environment.
 *
 * Unknown methods reject with `UNKNOWN_METHOD`; handlers that throw a
 * {@link BridgeError} keep its `code` / `message` / `data`, anything else
 * becomes `HANDLER_ERROR`.
 *
 * @typeParam M - Method schema.
 * @typeParam E - Event schema.
 * @param handlers - Local implementations, keyed by native method name.
 * @param options - Latency, timeout and debug options.
 * @returns A mock bridge with an extra `emit` helper and recorded `calls`.
 *
 * @example
 * ```ts
 * import { createMockBridge } from '@jswork/wk-bridge';
 *
 * const bridge = createMockBridge({
 *   'app.info': async () => ({ platform: 'browser', version: 'dev' }),
 *   'auth.login': async ({ username }) => {
 *     if (!username) throw new BridgeError('invalid_params', 'username is required');
 *     return { token: 'mock-token' };
 *   },
 * });
 *
 * const info = await bridge.call('app.info');
 * bridge.emit('theme.changed', { theme: 'dark' });
 * ```
 *
 * @see {@link createBridge} for the real WKWebView host.
 * @public
 */
export function createMockBridge<
  M extends MethodSchema<M> = MethodMap,
  E extends EventSchema<E> = EventMap
>(
  handlers: MockHandlers<M, E> = {} as MockHandlers<M, E>,
  options: MockOptions = {}
): MockBridge<M, E> {
  const calls: BridgeRequestMessage[] = [];
  const latency = options.latency;
  let bridge!: Bridge<M, E>;

  /** @internal */
  const nextLatency = (): number => {
    if (!latency) return 0;
    if (typeof latency === 'number') return Math.max(0, latency);
    const [min, max] = latency;
    const lower = Math.max(0, min);
    const upper = Math.max(lower, max);
    return lower + Math.random() * (upper - lower);
  };

  /** @internal */
  const failure = (id: string, code: string, message: string): BridgeFailureMessage => ({
    type: 'response',
    id,
    ok: false,
    error: { code, message }
  });

  /** @internal */
  const context: MockContext<E> = {
    emit(event, payload) {
      bridge.receive({ type: 'event', event, data: payload });
    }
  };

  /** @internal */
  async function respond(request: BridgeRequestMessage): Promise<void> {
    const handler = handlers[request.method as keyof M];
    if (typeof handler !== 'function') {
      bridge.receive(
        failure(request.id, ErrorCodes.UNKNOWN_METHOD, `No mock handler for "${request.method}"`)
      );
      return;
    }

    try {
      const result = await (handler as (params: unknown, ctx: MockContext<E>) => unknown)(
        request.params,
        context
      );
      const response: BridgeResponseMessage = {
        type: 'response',
        id: request.id,
        ok: true,
        result: result === undefined ? null : result
      };
      bridge.receive(response);
    } catch (error) {
      if (BridgeError.is(error)) {
        const response: BridgeFailureMessage = {
          type: 'response',
          id: request.id,
          ok: false,
          error: { code: error.code, message: error.message, data: error.data }
        };
        bridge.receive(response);
        return;
      }

      bridge.receive(
        failure(
          request.id,
          ErrorCodes.HANDLER_ERROR,
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  /**
   * In-memory transport: records the request and answers asynchronously.
   * @internal
   */
  const transport: NativeTransport = {
    postMessage(message: unknown): void {
      const request = message as BridgeRequestMessage;
      calls.push(request);
      setTimeout(() => {
        void respond(request);
      }, nextLatency());
    }
  };

  bridge = createBridge<M, E>({
    channel: options.channel ?? 'mock',
    transport,
    installGlobal: false,
    timeout: options.timeout,
    debug: options.debug,
    idPrefix: options.idPrefix,
    onListenerError: options.onListenerError
  });

  const mock = bridge as MockBridge<M, E>;
  Object.defineProperties(mock, {
    emit: {
      enumerable: true,
      value: (event: string, payload: unknown): void => {
        bridge.receive({ type: 'event', event, data: payload });
      }
    },
    calls: {
      enumerable: true,
      get: (): ReadonlyArray<BridgeRequestMessage> => calls.slice()
    }
  });

  return mock;
}
