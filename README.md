# @jswork/wk-bridge

> Promise-based H5 bridge for WKWebView: typed calls, events, zero dependencies.

[![version][version-image]][version-url]
[![license][license-image]][license-url]
[![download][download-image]][download-url]

A small, framework-agnostic H5 client for the classic "Swift wraps a
`WKWebView`, H5 talks to native through a bridge" setup. It owns the page half
of the protocol: request/response correlation, events, timeouts, cancellation,
error codes and a mock adapter for browser development.

- **Zero runtime dependencies**, ~1 file of code once bundled.
- **Typed methods and events** through a single generic factory.
- **Promise-based** `call`, with `timeout` and `AbortSignal`.
- **Events** with `on` / `once` / `off` and listener error isolation.
- **Mock bridge** so the H5 app runs in a normal browser or in `bun test`.
- CJS + ESM + `.d.ts`, tree-shakeable (`sideEffects: false`).

## installation

```shell
pnpm add @jswork/wk-bridge
# npm i @jswork/wk-bridge
# yarn add @jswork/wk-bridge
```

## quick start

```ts
import { createBridge } from '@jswork/wk-bridge';

interface Methods {
  'app.info': { params: { verbose?: boolean }; result: { platform: string; version: string } };
  'auth.login': { params: { username: string }; result: { token: string } };
}

interface Events {
  'bridge.ready': { protocol: string; url: string };
  'theme.changed': { theme: 'dark' | 'light' };
}

const bridge = createBridge<Methods, Events>({ timeout: 15_000 });

const info = await bridge.call('app.info', { verbose: true });
console.log(info.platform);

const unsubscribe = bridge.on('theme.changed', ({ theme }) => {
  document.documentElement.dataset.theme = theme;
});

bridge.on('bridge.ready', ({ protocol }) => console.log('native protocol', protocol));
```

`bridge.call` rejects with a `BridgeError`; nothing throws synchronously:

```ts
import { BridgeError, ErrorCodes } from '@jswork/wk-bridge';

try {
  const controller = new AbortController();
  await bridge.call('auth.login', { username: '' }, { timeout: 5_000, signal: controller.signal });
} catch (error) {
  if (BridgeError.is(error)) {
    if (error.code === ErrorCodes.TIMEOUT) {
      // native did not answer in time
    } else if (error.code === 'invalid_params') {
      // application code sent by the Swift handler
    }
    console.log(error.method, error.code, error.data);
  }
}
```

## configuration

```ts
createBridge({
  channel: 'bridge', // must match the WKScriptMessageHandler name
  timeout: 10_000, // default per-call timeout, ms; 0 disables
  debug: true, // or (message, ...args) => logger.debug(...)
  global: globalThis, // injectable for tests / iframes
  receiveKey: '__wkbridge__',
  inboxKey: '__wkbridgeInbox__',
  installGlobal: true, // false in tests that do not want a global
  idPrefix: 'r',
  onListenerError: (error, event) => report(error)
});
```

The transport is auto-detected as `global.webkit.messageHandlers[channel]`.
It is re-checked lazily, so a handler injected after page load still works.
Pass `transport` to supply your own `{ postMessage(message) {} }` implementation.

## events

```ts
bridge.on('theme.changed', listener); // returns an unsubscribe function
bridge.once('bridge.ready', listener); // fires once
bridge.off('theme.changed', listener); // same function reference
```

Events are one-way pushes from native. A throwing listener never stops the
others; the error goes to `onListenerError` (default: `console.error`).

## mock bridge

```ts
import { createMockBridge, BridgeError } from '@jswork/wk-bridge';

const bridge = createMockBridge<Methods, Events>(
  {
    'app.info': () => ({ platform: 'browser', version: 'dev' }),
    'auth.login': ({ username }) => {
      if (!username) throw new BridgeError('invalid_params', 'username is required');
      return { token: 'mock-token' };
    }
  },
  { latency: [20, 80] }
);

bridge.emit('theme.changed', { theme: 'dark' });
await bridge.call('app.info');
console.log(bridge.calls); // recorded requests, for assertions
```

The mock never touches `window`, answers asynchronously, and reports
`available: true`, so the same application code runs in the browser and in the
web view.

## native side (minimal)

The Swift host needs one `WKScriptMessageHandler` named `bridge`; replies are
evaluated on the page world:

```swift
func userContentController(
  _ controller: WKUserContentController,
  didReceive message: WKScriptMessage
) {
  guard let body = message.body as? [String: Any],
        let id = body["id"] as? String,
        let method = body["method"] as? String else { return }

  Task { @MainActor in
    let result = try await dispatch(method, body["params"] as? [String: Any] ?? [:])
    _ = try await webView.callAsyncJavaScript(
      "window.__wkbridge__?.receive(payload)",
      arguments: ["payload": ["type": "response", "id": id, "ok": true, "result": result]],
      in: nil,
      contentWorld: .page
    )
  }
}
```

Full guide, including error payloads, early-message inbox and lifecycle
handling: [docs/native-integration.md](docs/native-integration.md).

## API

| Export                                 | Description                                                   |
| -------------------------------------- | ------------------------------------------------------------- |
| `createBridge<M, E>(options?)`         | Creates the bridge bound to a web view channel                |
| `createMockBridge(handlers, options?)` | In-memory bridge for browser/tests                            |
| `BridgeError`                          | Error class with `code`, `message`, `method`, `data`, `cause` |
| `ErrorCodes`                           | Built-in codes: `TIMEOUT`, `ABORTED`, `BRIDGE_UNAVAILABLE`, … |
| `VERSION`                              | Library version (`1.0.0`)                                     |

| Instance                          | Description                                                       |
| --------------------------------- | ----------------------------------------------------------------- |
| `call(method, params?, options?)` | Promise-based request; `options.timeout`, `options.signal`        |
| `on` / `once` / `off`             | Event subscription                                                |
| `receive(payload)`                | Feed an inbound message (used by the global receiver)             |
| `available`                       | Whether a native transport is currently detected                  |
| `pendingCount`                    | Number of in-flight calls                                         |
| `channel` / `version`             | Channel name and library version                                  |
| `destroy()`                       | Reject pending calls, clear listeners, remove the global receiver |
| `emit` / `calls`                  | Mock-only: push an event / inspect recorded requests              |

## protocol

Three JSON message kinds — `request`, `response`, `event` — documented in
[docs/protocol.md](docs/protocol.md). Built-in error codes and lifecycle rules
are there too.

## license

Code released under [the MIT license](LICENSE.txt).

[version-image]: https://img.shields.io/npm/v/@jswork/wk-bridge
[version-url]: https://npmjs.org/package/@jswork/wk-bridge
[license-image]: https://img.shields.io/npm/l/@jswork/wk-bridge
[license-url]: https://github.com/afeiship/wk-bridge/blob/main/LICENSE.txt
[download-image]: https://img.shields.io/npm/dm/@jswork/wk-bridge
[download-url]: https://www.npmjs.com/package/@jswork/wk-bridge
