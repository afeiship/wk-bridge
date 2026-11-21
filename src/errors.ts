/**
 * Built-in error codes produced by the bridge itself.
 *
 * Codes returned by a native host are passed through untouched, so consumers
 * should treat {@link BridgeError.code} as an open string set.
 * @public
 */
export const ErrorCodes = {
  /** No native transport is reachable for the configured channel. */
  UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
  /** The native side did not answer within the call timeout. */
  TIMEOUT: 'TIMEOUT',
  /** The call was cancelled through an `AbortSignal`. */
  ABORTED: 'ABORTED',
  /** The bridge was destroyed while the call was pending. */
  DISPOSED: 'DISPOSED',
  /** A method name other than a non-empty string was supplied. */
  INVALID_METHOD: 'INVALID_METHOD',
  /** `postMessage` threw while sending the request. */
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  /** The native side failed without providing a code. */
  UNKNOWN: 'UNKNOWN',
  /** Mock bridge only: no handler was registered for the method. */
  UNKNOWN_METHOD: 'UNKNOWN_METHOD',
  /** Mock bridge only: the handler threw a non-{@link BridgeError} value. */
  HANDLER_ERROR: 'HANDLER_ERROR'
} as const;

/** Union of the codes defined in {@link ErrorCodes}. @public */
export type BuiltInErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Error code type used by {@link BridgeError}.
 *
 * Keeps editor completion for built-in codes while still accepting arbitrary
 * native codes such as `"invalid_params"`.
 * @public
 */
export type BridgeErrorCode = BuiltInErrorCode | (string & {});

/**
 * Optional metadata attached to a {@link BridgeError}.
 * @public
 */
export interface BridgeErrorOptions {
  /** Native method that produced the error. */
  method?: string;
  /** Structured details returned by native. */
  data?: unknown;
  /** Underlying cause, e.g. the exception thrown by `postMessage`. */
  cause?: unknown;
}

/**
 * Rejection value used by every failed bridge call.
 *
 * Extends `Error`, so `instanceof Error` works in every runtime, and adds
 * `code`, `method`, `data` and `cause` for programmatic handling.
 *
 * @example
 * ```ts
 * try {
 *   await bridge.call('auth.login', { username: '' });
 * } catch (error) {
 *   if (BridgeError.is(error)) {
 *     console.warn(error.code, error.message, error.data);
 *   }
 * }
 * ```
 * @public
 */
export class BridgeError extends Error {
  /** Machine-readable code, either built-in or defined by the native host. */
  readonly code: BridgeErrorCode;
  /** Native method this error belongs to, when known. */
  readonly method?: string;
  /** Structured details returned by the native host. */
  readonly data?: unknown;
  /** Underlying cause, when the bridge wrapped another error. */
  declare cause?: unknown;

  /**
   * Creates a bridge error.
   *
   * @param code - Machine-readable error code.
   * @param message - Human-readable description. Defaults to `code`.
   * @param options - Method name, structured data and cause.
   */
  constructor(code: BridgeErrorCode, message?: string, options: BridgeErrorOptions = {}) {
    super(message ?? code);
    this.name = 'BridgeError';
    this.code = code;
    this.method = options.method;
    this.data = options.data;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  /**
   * Narrows an unknown rejection value to a bridge error.
   *
   * @param error - Value caught from a rejected call.
   * @returns `true` when the value is a {@link BridgeError}.
   */
  static is(error: unknown): error is BridgeError {
    return error instanceof BridgeError;
  }
}
