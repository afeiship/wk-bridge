import type { BridgeGlobal, NativeTransport } from './types';

/**
 * Looks up a `WKScriptMessageHandler` port on a WKWebView-style global.
 *
 * Detection is intentionally lazy: the native receiver may already exist on
 * the first call (the usual `atDocumentStart` case), and re-checking each
 * time makes late injection work too.
 *
 * @param globalObject - Object carrying the `webkit` tree.
 * @param channel - Message-handler name to look up.
 * @returns The handler port, or `undefined` when unavailable.
 * @internal
 */
export function detectTransport(
  globalObject: BridgeGlobal,
  channel: string
): NativeTransport | undefined {
  const port = globalObject.webkit?.messageHandlers?.[channel];
  if (port && typeof port.postMessage === 'function') {
    return port;
  }
  return undefined;
}
