# Protocol

`@jswork/wk-bridge` speaks a small JSON protocol over one `WKScriptMessageHandler`
channel. It is intentionally plain: every message is a JSON-serializable object,
so the H5 side and the Swift side can be developed and tested independently.

## Direction and transport

| Direction   | Mechanism                                                                      |
| ----------- | ------------------------------------------------------------------------------ |
| H5 → native | `window.webkit.messageHandlers.bridge.postMessage(message)`                    |
| native → H5 | evaluate `window.__wkbridge__?.receive(payload)` with `payload` as an argument |
| boot event  | native pushes `bridge.ready` after `webView(_:didFinish:)`                     |

The page-side receiver is installed by the library on `globalThis.__wkbridge__`:

```ts
interface BridgeGlobalReceiver {
  receive(payload: unknown): void;
  version: string;
  channel: string;
}
```

`payload` may be an object or a JSON string; the library parses strings and
ignores anything that is not a valid bridge message.

## Messages

### Request (H5 → native)

```json
{ "id": "r1-mfa2k3", "method": "app.info", "params": { "verbose": true } }
```

- `id` — unique per call, generated as `<prefix><seq36>-<time36>`.
- `method` — native method name, e.g. `app.info`.
- `params` — always an object; `{}` when the caller omits params.

### Response (native → H5), success

```json
{ "type": "response", "id": "r1-mfa2k3", "ok": true, "result": { "platform": "iOS" } }
```

### Response (native → H5), failure

```json
{
  "type": "response",
  "id": "r1-mfa2k3",
  "ok": false,
  "error": {
    "code": "invalid_params",
    "message": "username is required",
    "data": { "field": "username" }
  }
}
```

`code`, `message` and `data` are all optional on the wire; a missing `code`
becomes `UNKNOWN` on the H5 side. Native handlers are encouraged to throw
`BridgeError` with a stable code.

### Event (native → H5)

```json
{ "type": "event", "event": "theme.changed", "data": { "theme": "dark" } }
```

Events are one-way and fire-and-forget. Unknown event names are simply not
delivered to any listener.

## Built-in error codes

| Code                 | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `BRIDGE_UNAVAILABLE` | No native handler on the configured channel         |
| `TIMEOUT`            | Native did not answer before the call timeout       |
| `ABORTED`            | Caller aborted through `AbortSignal`                |
| `DISPOSED`           | Bridge was destroyed while the call was pending     |
| `INVALID_METHOD`     | Empty or non-string method name                     |
| `TRANSPORT_ERROR`    | `postMessage` threw (e.g. web content process gone) |
| `UNKNOWN`            | Native sent `ok: false` without a code              |
| `UNKNOWN_METHOD`     | Mock / native has no handler for the method         |
| `HANDLER_ERROR`      | Mock handler threw a non-`BridgeError`              |

Native app codes pass through unchanged. Use `snake_case` such as
`invalid_params`, `not_authenticated`, `cancelled`.

## Lifecycle rules

- Calls are independent: several may be in flight, and responses may arrive out
  of order. Matching is strictly by `id`.
- `timeout` is per call (default `10000` ms). `timeout: 0` disables the timer.
- `signal` removes the pending call and rejects with `ABORTED`; an already
  aborted signal rejects before anything is posted.
- Responses for unknown or already settled ids are ignored.
- `destroy()` rejects every pending call with `DISPOSED`, clears listeners and
  removes the global receiver if this instance installed it.
- Listener exceptions never break dispatch; they go to `onListenerError`
  (defaults to `console.error`).

## Early messages and the inbox

If native wants to push something before the page-side receiver exists, it can
append to `window.__wkbridgeInbox__`. On construction the library drains that
array with `splice(0)` and feeds each entry to `receive`.

```js
window.__wkbridgeInbox__ = window.__wkbridgeInbox__ || [];
window.__wkbridgeInbox__.push({ type: 'event', event: 'boot', data: { ready: true } });
```

The same queue is useful when the bridge script is injected after some native
messages have already been queued.

## Versioning

`VERSION` is `1.0.0` and the boot event advertises protocol `"1.0"`:

```json
{
  "type": "event",
  "event": "bridge.ready",
  "data": { "protocol": "1.0", "url": "https://example.com" }
}
```

Treat `protocol` as the compatibility key, not the npm version.
