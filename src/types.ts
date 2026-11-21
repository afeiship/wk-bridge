/** A primitive value that survives a JSON round trip. @public */
export type JsonPrimitive = string | number | boolean | null;

/** Any value that survives a JSON serialization round trip. @public */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A plain JSON object payload. @public */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Describes one native method: its parameter shape (`params`) and its result shape (`result`).
 *
 * Use `void` for methods that take no parameters.
 *
 * @example
 * ```ts
 * interface AppMethods {
 *   'app.info': MethodSpec<void, AppInfo>;
 *   'storage.get': MethodSpec<{ key: string }, { key: string; value: string }>;
 * }
 * ```
 * @public
 */
export interface MethodSpec<TParams = unknown, TResult = unknown> {
  /** Parameter type accepted by {@link Bridge.call}. */
  params: TParams;
  /** Value type resolved by {@link Bridge.call}. */
  result: TResult;
}

/**
 * Method schema accepted by {@link createBridge}.
 *
 * `any` is used on purpose so an untyped bridge (`createBridge()`) still compiles.
 * @public
 */
export type MethodMap = Record<string, MethodSpec<any, any>>;

/**
 * Structural constraint for method schemas.
 *
 * `M extends MethodMap` rejects `interface` declarations because interfaces
 * have no implicit index signature. This mapped form checks each property
 * instead, so both interfaces and type aliases work:
 *
 * ```ts
 * interface Methods {
 *   'app.info': { params: { verbose?: boolean }; result: AppInfo };
 * }
 * const bridge = createBridge<Methods>();
 * ```
 * @public
 */
export type MethodSchema<M> = { [K in keyof M]: MethodSpec<any, any> };

/**
 * Event schema accepted by {@link createBridge}.
 *
 * The key is the event name emitted by the native host, the value is the payload type.
 * @public
 */
export type EventMap = Record<string, unknown>;

/**
 * Structural constraint for event schemas.
 *
 * Mirrors {@link MethodSchema}: accepts `interface` declarations as well as
 * type aliases, while checking that every key maps to a payload type.
 *
 * ```ts
 * interface Events {
 *   'theme.changed': { theme: 'dark' | 'light' };
 * }
 * const bridge = createBridge<Methods, Events>();
 * ```
 * @public
 */
export type EventSchema<E> = { [K in keyof E]: unknown };

/** Extracts the `params` type from a {@link MethodSpec}. @public */
export type ParamsOf<TSpec> = TSpec extends MethodSpec<infer TParams, any> ? TParams : never;

/** Extracts the `result` type from a {@link MethodSpec}. @public */
export type ResultOf<TSpec> = TSpec extends MethodSpec<any, infer TResult> ? TResult : never;

/** Returned by {@link Bridge.on} and {@link Bridge.once} to stop listening. @public */
export type Unsubscribe = () => void;

/** Listener signature used by {@link Bridge.on} and {@link Bridge.once}. @public */
export type BridgeListener<TPayload> = (payload: TPayload) => void;

/**
 * Per-call options.
 * @public
 */
export interface CallOptions {
  /**
   * Milliseconds to wait before rejecting with `TIMEOUT`.
   *
   * `0` disables the timeout. Defaults to the bridge-level `timeout` option.
   */
  timeout?: number;

  /**
   * Cancels the local wait and rejects with `ABORTED`.
   *
   * The native handler is not interrupted, so side-effecting calls must stay idempotent.
   */
  signal?: AbortSignal;
}

/**
 * Minimal transport contract the bridge talks to.
 *
 * A WKWebView `messageHandler` satisfies this shape as-is on a Mac / iOS web view.
 * @public
 */
export interface NativeTransport {
  /** Sends one JSON-serializable message to the native side. */
  postMessage(message: unknown): void;
}

/**
 * The subset of the `webkit` global used for auto-detecting a WKWebView host.
 * @public
 */
export interface WebKitMessageHandlers {
  /** Named `WKScriptMessageHandler` ports installed by the native host. */
  messageHandlers?: Record<string, NativeTransport | undefined>;
}

/**
 * Minimal shape of the global object the bridge reads from.
 *
 * Pass a custom object for SSR or unit tests.
 * @public
 */
export interface BridgeGlobal {
  /** Present inside WKWebView. */
  webkit?: WebKitMessageHandlers;
  /** Hosts the bridge receiver and the early-message inbox. */
  [key: string]: unknown;
}

/**
 * Debug logger used when `debug` is enabled.
 * @public
 */
export type DebugLogger = (message: string, detail?: unknown) => void;

/**
 * Options accepted by {@link createBridge}.
 * @public
 */
export interface BridgeOptions {
  /**
   * Native message-handler name registered on the Swift side.
   * @defaultValue `"bridge"`
   */
  channel?: string;

  /**
   * Custom transport used instead of auto-detection.
   *
   * Useful for tests, other platforms, or non-WKWebView containers.
   */
  transport?: NativeTransport;

  /**
   * Default per-call timeout in milliseconds. `0` disables it.
   * @defaultValue `10000`
   */
  timeout?: number;

  /**
   * Enables `console.debug` output, or supplies a custom logger.
   * @defaultValue `false`
   */
  debug?: boolean | DebugLogger;

  /**
   * Object used for auto-detection and receiver installation.
   * @defaultValue `globalThis`
   */
  global?: BridgeGlobal;

  /**
   * Global property name the native side calls to push messages.
   * @defaultValue `"__wkbridge__"`
   */
  receiveKey?: string;

  /**
   * Global property name used by the native side to queue messages before the page bridge boots.
   * @defaultValue `"__wkbridgeInbox__"`
   */
  inboxKey?: string;

  /**
   * Installs the receiver on `global`. Set to `false` when another layer owns delivery.
   * @defaultValue `true`
   */
  installGlobal?: boolean;

  /**
   * Prefix of generated request ids.
   * @defaultValue `"r"`
   */
  idPrefix?: string;

  /**
   * Called when an event listener throws. Defaults to `console.error`.
   *
   * Listener errors never break other listeners or the bridge itself.
   */
  onListenerError?: (error: unknown, event: string) => void;
}

/**
 * A request message sent from the web page to the native host.
 * @public
 */
export interface BridgeRequestMessage {
  /** Unique id echoed back by the native response. */
  id: string;
  /** Method name registered on the native side. */
  method: string;
  /** JSON parameters; the bridge always sends an object, `{}` when omitted. */
  params?: unknown;
}

/**
 * Error body returned by the native host.
 * @public
 */
export interface BridgeErrorPayload {
  /** Machine-readable code. Native hosts may define their own. */
  code?: string;
  /** Human-readable description. */
  message?: string;
  /** Optional structured details. */
  data?: unknown;
}

/**
 * Successful native response.
 * @public
 */
export interface BridgeResponseMessage {
  type: 'response';
  id: string;
  ok: true;
  result?: unknown;
}

/**
 * Failed native response.
 * @public
 */
export interface BridgeFailureMessage {
  type: 'response';
  id: string;
  ok: false;
  error?: BridgeErrorPayload;
}

/** Any native response, successful or not. @public */
export type BridgeResponse = BridgeResponseMessage | BridgeFailureMessage;

/**
 * Event pushed from the native host to the web page.
 * @public
 */
export interface BridgeEventMessage {
  type: 'event';
  event: string;
  data?: unknown;
}

/** Messages the bridge accepts from the native side. @public */
export type BridgeInboundMessage = BridgeResponse | BridgeEventMessage;

/**
 * Public bridge instance returned by {@link createBridge}.
 *
 * @typeParam M - Method schema; keys become the allowed method names.
 * @typeParam E - Event schema; keys become the subscribed event names.
 * @public
 */
export interface Bridge<
  M extends MethodSchema<M> = MethodMap,
  E extends EventSchema<E> = EventMap
> {
  /** Native message-handler name this bridge talks to. */
  readonly channel: string;
  /** Wire protocol version, also exposed to native hosts through the receiver object. */
  readonly version: string;
  /** `true` when a native transport is reachable. */
  readonly available: boolean;
  /** Number of calls still waiting for a native response. */
  readonly pendingCount: number;

  /**
   * Invokes a native method and resolves with its result.
   *
   * Rejects with a {@link BridgeError} carrying `TIMEOUT`, `ABORTED`,
   * `BRIDGE_UNAVAILABLE`, `TRANSPORT_ERROR` or any code returned by native.
   *
   * @typeParam K - Method name from the schema.
   * @param method - Registered native method name, e.g. `"app.info"`.
   * @param params - JSON parameters; omitted becomes `{}`.
   * @param options - Timeout and abort signal for this call only.
   * @returns A promise for the native result.
   */
  call<K extends keyof M & string>(
    method: K,
    params?: ParamsOf<M[K]>,
    options?: CallOptions
  ): Promise<ResultOf<M[K]>>;

  /**
   * Subscribes to a native event.
   *
   * @typeParam K - Event name from the schema.
   * @param event - Event name, e.g. `"theme.changed"`.
   * @param listener - Called with the event payload.
   * @returns A function that removes the listener.
   */
  on<K extends keyof E & string>(event: K, listener: BridgeListener<E[K]>): Unsubscribe;

  /**
   * Subscribes to the next occurrence of an event only.
   *
   * @typeParam K - Event name from the schema.
   * @param event - Event name.
   * @param listener - Called once with the event payload.
   * @returns A function that removes the listener before it fires.
   */
  once<K extends keyof E & string>(event: K, listener: BridgeListener<E[K]>): Unsubscribe;

  /**
   * Removes a listener registered with {@link Bridge.on} or {@link Bridge.once}.
   *
   * @typeParam K - Event name from the schema.
   * @param event - Event name.
   * @param listener - The original listener passed to `on` / `once`.
   */
  off<K extends keyof E & string>(event: K, listener: BridgeListener<E[K]>): void;

  /**
   * Feeds one native message into the bridge.
   *
   * Called by the global receiver automatically; call it directly when
   * `installGlobal` is disabled or when tests simulate the native side.
   *
   * Accepts an object or a JSON string. Unknown / stale messages are ignored.
   *
   * @param payload - Parsed message or JSON text.
   */
  receive(payload: unknown): void;

  /**
   * Rejects pending calls with `DISPOSED`, clears listeners and removes the global receiver.
   *
   * The instance is unusable afterwards. Calling it twice is a no-op.
   */
  destroy(): void;
}
