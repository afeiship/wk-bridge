import { createBridge } from './bridge';

export { createBridge } from './bridge';
export { createMockBridge } from './mock';
export { BridgeError, ErrorCodes } from './errors';
export {
  DEFAULT_CHANNEL,
  DEFAULT_INBOX_KEY,
  DEFAULT_RECEIVE_KEY,
  DEFAULT_TIMEOUT,
  VERSION
} from './constants';

export type { BridgeErrorCode, BridgeErrorOptions, BuiltInErrorCode } from './errors';
export type {
  Bridge,
  BridgeErrorPayload,
  BridgeEventMessage,
  BridgeFailureMessage,
  BridgeGlobal,
  BridgeInboundMessage,
  BridgeListener,
  BridgeOptions,
  BridgeRequestMessage,
  BridgeResponse,
  BridgeResponseMessage,
  CallOptions,
  DebugLogger,
  EventMap,
  EventSchema,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  MethodMap,
  MethodSchema,
  MethodSpec,
  NativeTransport,
  ParamsOf,
  ResultOf,
  Unsubscribe,
  WebKitMessageHandlers
} from './types';
export type { MockBridge, MockContext, MockHandler, MockHandlers, MockOptions } from './mock';

/**
 * Default export, identical to {@link createBridge}.
 *
 * Handy for `import createBridge from '@jswork/wk-bridge'` when a project
 * prefers a single default import.
 *
 * @public
 */
export default createBridge;
