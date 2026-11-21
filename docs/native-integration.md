# Native integration (Swift / WKWebView)

This guide wires `@jswork/wk-bridge` to a Swift host. The H5 side is the npm
package; the native side is a small `WKScriptMessageHandler` that dispatches
requests and pushes events back.

The complete worked example lives in
[`aric-notes/SwiftBridgeH5`](https://github.com/afeiship/aric-notes) — this page
is the minimal version you can paste into an existing app.

## 1. Configure the web view

Register exactly one message handler whose name matches the bridge channel
(default `bridge`):

```swift
let configuration = WKWebViewConfiguration()
let controller = WKUserContentController()
controller.add(WeakScriptMessageHandler(target: bridge), name: "bridge")
configuration.userContentController = controller

let webView = WKWebView(frame: .zero, configuration: configuration)
bridge.attach(webView)
```

`WeakScriptMessageHandler` is required: `WKUserContentController` retains its
handlers, and the handler usually retains the web view.

```swift
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  private weak var target: WKScriptMessageHandler?

  init(target: WKScriptMessageHandler) {
    self.target = target
  }

  func userContentController(
    _ controller: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    target?.userContentController(controller, didReceive: message)
  }
}
```

## 2. Handle incoming requests

```swift
import WebKit

struct BridgeError: Error {
  let code: String
  let message: String
  var data: Any?
}

@MainActor
final class H5Bridge: NSObject, WKScriptMessageHandler {
  private weak var webView: WKWebView?
  private var handlers: [String: ([String: Any]) async throws -> Any?] = [:]

  func attach(_ webView: WKWebView) {
    self.webView = webView
    webView.navigationDelegate = self
  }

  func register(_ method: String, _ handler: @escaping ([String: Any]) async throws -> Any?) {
    handlers[method] = handler
  }

  func userContentController(
    _ controller: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard message.name == "bridge",
          message.frameInfo.isMainFrame,
          let body = message.body as? [String: Any],
          let id = body["id"] as? String,
          let method = body["method"] as? String
    else { return }

    let params = body["params"] as? [String: Any] ?? [:]

    Task { @MainActor in
      do {
        guard let handler = self.handlers[method] else {
          throw BridgeError(code: "unknown_method", message: "No handler for \(method)")
        }
        let result = try await handler(params)
        try await self.send([
          "type": "response",
          "id": id,
          "ok": true,
          "result": result ?? NSNull(),
        ])
      } catch let error as BridgeError {
        try? await self.sendFailure(id: id, error: error)
      } catch {
        try? await self.sendFailure(
          id: id,
          error: BridgeError(code: "handler_error", message: error.localizedDescription)
        )
      }
    }
  }
}
```

## 3. Reply to the page

Never build JavaScript by string concatenation with user data. Pass the payload
as an argument instead:

```swift
private func send(_ payload: [String: Any]) async throws {
  guard let webView else { return }
  _ = try await webView.callAsyncJavaScript(
    "window.__wkbridge__?.receive(payload)",
    arguments: ["payload": payload],
    in: nil,
    contentWorld: .page
  )
}

private func sendFailure(id: String, error: BridgeError) async throws {
  var errorPayload: [String: Any] = [
    "code": error.code,
    "message": error.message,
  ]
  errorPayload["data"] = error.data ?? NSNull()

  try await send([
    "type": "response",
    "id": id,
    "ok": false,
    "error": errorPayload,
  ])
}
```

`contentWorld: .page` matters: the receiver lives on the page world, not the
default isolated world. `callAsyncJavaScript` is available on iOS 14 / macOS 11
and later, which matches the library's target.

Optional chaining (`window.__wkbridge__?.receive(...)`) makes replies safe
before the H5 bundle has installed the receiver. The value returned by
`callAsyncJavaScript` is `nil` in that case; log it in debug builds if you want
to notice lost early replies.

## 4. Push events

```swift
func emit(_ event: String, data: Any? = nil) async throws {
  try await send([
    "type": "event",
    "event": event,
    "data": data ?? NSNull(),
  ])
}

// After webView(_:didFinish:)
try await emit("bridge.ready", data: ["protocol": "1.0", "url": webView.url?.absoluteString ?? ""])
```

For messages that must not be lost before the page boots, append them to the
inbox instead:

```swift
let script = """
window.__wkbridgeInbox__ = window.__wkbridgeInbox__ || [];
window.__wkbridgeInbox__.push(payload);
"""

_ = try await webView.callAsyncJavaScript(
  script,
  arguments: ["payload": ["type": "event", "event": "boot", "data": ["ready": true]],
  in: nil,
  contentWorld: .page
)
```

The library drains `window.__wkbridgeInbox__` when it is constructed, so queued
events are delivered once the H5 bundle runs.

## 5. Navigation lifecycle

```swift
extension H5Bridge: WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Task { try? await emit("bridge.ready", data: ["protocol": "1.0"]) }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }
}
```

Reloading after a content-process crash restores the JS receiver. Pending calls
from before the crash will time out unless your app retries them; the library
does not retry automatically.

On iOS 15+ / macOS 12+ enable inspection in debug builds:

```swift
#if DEBUG
if #available(iOS 16.4, macOS 13.3, *) {
  webView.isInspectable = true
}
#endif
```

## 6. Security checklist

- Verify `message.frameInfo.isMainFrame`; ignore sub-frames.
- Allowlist hosts before exposing privileged methods; serve only trusted pages.
- Treat `params` as untrusted input; validate types and ranges in each handler.
- Never pass tokens or secrets into events that any page script can read.
- Keep the channel name private-ish and stable; it is not an auth boundary.

## 7. Testing without a device

Because the protocol is transport-agnostic, the H5 app can run in a normal
browser with `createMockBridge` and the same method names. Only the native
implementation needs a simulator or device.
