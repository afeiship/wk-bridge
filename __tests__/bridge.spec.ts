import { describe, expect, test } from 'bun:test';
import { BridgeError, ErrorCodes, VERSION, createBridge } from '../src';
import type { BridgeGlobal, BridgeOptions, BridgeRequestMessage, NativeTransport } from '../src';

/**
 * Creates a bridge backed by an in-memory transport that records requests.
 *
 * @param options - Bridge options overriding the defaults.
 * @returns The bridge, captured requests and helper to reply / fail.
 */
function createHarness(options: Partial<BridgeOptions> = {}) {
  const sent: BridgeRequestMessage[] = [];
  const transport: NativeTransport = {
    postMessage(message: unknown): void {
      sent.push(message as BridgeRequestMessage);
    }
  };
  const globalObject: BridgeGlobal = {};
  const bridge = createBridge({ transport, global: globalObject, ...options });

  const reply = (index: number, result: unknown): void => {
    bridge.receive({ type: 'response', id: sent[index]!.id, ok: true, result });
  };

  const fail = (index: number, error: Record<string, unknown>): void => {
    bridge.receive({ type: 'response', id: sent[index]!.id, ok: false, error });
  };

  return { bridge, sent, globalObject, reply, fail };
}

describe('requests', () => {
  test('posts a request and resolves with the native result', async () => {
    const { bridge, sent } = createHarness();

    const pending = bridge.call('app.info', { verbose: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'app.info', params: { verbose: true } });
    expect(typeof sent[0]!.id).toBe('string');
    expect(bridge.pendingCount).toBe(1);

    bridge.receive({ type: 'response', id: sent[0]!.id, ok: true, result: { platform: 'macOS' } });

    expect(await pending).toEqual({ platform: 'macOS' });
    expect(bridge.pendingCount).toBe(0);
  });

  test('sends an empty object when params are omitted', async () => {
    const { bridge, sent, reply } = createHarness();

    const pending = bridge.call('app.ping');
    expect(sent[0]!.params).toEqual({});
    reply(0, null);

    expect(await pending).toBeNull();
  });

  test('supports concurrent calls and out-of-order responses', async () => {
    const { bridge, sent } = createHarness();

    const first = bridge.call('demo.one');
    const second = bridge.call('demo.two');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.id).not.toBe(sent[1]!.id);

    bridge.receive({ type: 'response', id: sent[1]!.id, ok: true, result: 'second' });
    bridge.receive({ type: 'response', id: sent[0]!.id, ok: true, result: 'first' });

    expect(await first).toBe('first');
    expect(await second).toBe('second');
  });

  test('maps native error payloads to BridgeError', async () => {
    const { bridge, fail } = createHarness();

    const pending = bridge.call('auth.login', { username: '' });
    fail(0, {
      code: 'invalid_params',
      message: 'username is required',
      data: { field: 'username' }
    });

    const error = await pending.catch((reason: unknown) => reason);
    expect(BridgeError.is(error)).toBe(true);
    const bridgeError = error as BridgeError;
    expect(bridgeError.code).toBe('invalid_params');
    expect(bridgeError.message).toBe('username is required');
    expect(bridgeError.method).toBe('auth.login');
    expect(bridgeError.data).toEqual({ field: 'username' });
  });

  test('rejects unknown resolved / settled responses without touching state', async () => {
    const { bridge, sent } = createHarness();

    const pending = bridge.call('app.info');
    bridge.receive({ type: 'response', id: 'r999-missing', ok: true, result: 'stale' });
    expect(bridge.pendingCount).toBe(1);

    bridge.receive({ type: 'response', id: sent[0]!.id, ok: true, result: 'real' });
    expect(await pending).toBe('real');
  });

  test('rejects with TIMEOUT when native stays silent', async () => {
    const { bridge } = createHarness({ timeout: 10 });

    const error = await bridge.call('demo.slow').catch((reason: unknown) => reason);
    expect(BridgeError.is(error)).toBe(true);
    expect((error as BridgeError).code).toBe(ErrorCodes.TIMEOUT);
    expect(bridge.pendingCount).toBe(0);
  });

  test('rejects with ABORTED when the signal fires', async () => {
    const { bridge } = createHarness();
    const controller = new AbortController();

    const pending = bridge.call('demo.slow', {}, { signal: controller.signal });
    controller.abort();

    const error = await pending.catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.ABORTED);
    expect(bridge.pendingCount).toBe(0);
  });

  test('rejects with ABORTED when the signal is already aborted', async () => {
    const { bridge, sent } = createHarness();
    const controller = new AbortController();
    controller.abort();

    const error = await bridge
      .call('demo.slow', {}, { signal: controller.signal })
      .catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.ABORTED);
    expect(sent).toHaveLength(0);
  });

  test('rejects with BRIDGE_UNAVAILABLE outside a WKWebView host', async () => {
    const bridge = createBridge({ global: {} });
    expect(bridge.available).toBe(false);

    const error = await bridge.call('app.info').catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.UNAVAILABLE);
    expect(bridge.available).toBe(false);
  });

  test('rejects with TRANSPORT_ERROR when postMessage throws', async () => {
    const failing: NativeTransport = {
      postMessage(): void {
        throw new Error('port closed');
      }
    };
    const bridge = createBridge({ transport: failing, global: {} });

    const error = await bridge.call('app.info').catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.TRANSPORT_ERROR);
    expect((error as BridgeError).cause).toBeInstanceOf(Error);
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('transport detection', () => {
  test('auto-detects window.webkit.messageHandlers[channel]', async () => {
    const sent: BridgeRequestMessage[] = [];
    const globalObject: BridgeGlobal = {
      webkit: {
        messageHandlers: {
          bridge: {
            postMessage(message: unknown): void {
              sent.push(message as BridgeRequestMessage);
            }
          }
        }
      }
    };
    const bridge = createBridge({ global: globalObject });
    expect(bridge.available).toBe(true);

    const pending = bridge.call('app.info');
    expect(sent).toHaveLength(1);
    bridge.receive({ type: 'response', id: sent[0]!.id, ok: true, result: 'ok' });

    expect(await pending).toBe('ok');
    expect(bridge.channel).toBe('bridge');
    expect(bridge.version).toBe(VERSION);
  });

  test('detects a handler injected after the bridge was created', async () => {
    const globalObject: BridgeGlobal = {};
    const bridge = createBridge({ global: globalObject });
    expect(bridge.available).toBe(false);

    const sent: BridgeRequestMessage[] = [];
    globalObject.webkit = {
      messageHandlers: {
        bridge: {
          postMessage(message: unknown): void {
            sent.push(message as BridgeRequestMessage);
          }
        }
      }
    };
    expect(bridge.available).toBe(true);

    const pending = bridge.call('app.info');
    expect(sent).toHaveLength(1);
    bridge.receive({ type: 'response', id: sent[0]!.id, ok: true, result: 'late' });

    expect(await pending).toBe('late');
  });

  test('honours a custom channel name', async () => {
    const sent: BridgeRequestMessage[] = [];
    const globalObject: BridgeGlobal = {
      webkit: {
        messageHandlers: {
          custom: {
            postMessage(message: unknown): void {
              sent.push(message as BridgeRequestMessage);
            }
          }
        }
      }
    };
    const bridge = createBridge({ channel: 'custom', global: globalObject });

    const pending = bridge.call('app.info');
    expect(sent).toHaveLength(1);
    bridge.receive({ type: 'response', id: sent[0]!.id, ok: true, result: 'custom' });

    expect(await pending).toBe('custom');
    expect(bridge.channel).toBe('custom');
  });
});

describe('global receiver', () => {
  test('installs __wkbridge__ and accepts JSON text', async () => {
    const { bridge, sent, globalObject } = createHarness();
    const receiver = globalObject['__wkbridge__'] as {
      receive: (payload: unknown) => void;
      version: string;
      channel: string;
    };
    expect(typeof receiver.receive).toBe('function');
    expect(receiver.version).toBe(VERSION);
    expect(receiver.channel).toBe('bridge');

    const pending = bridge.call('app.info');
    receiver.receive(
      JSON.stringify({ type: 'response', id: sent[0]!.id, ok: true, result: 'from-json' })
    );

    expect(await pending).toBe('from-json');
  });

  test('drains messages queued in __wkbridgeInbox__ before boot', () => {
    const globalObject: BridgeGlobal = {
      ['__wkbridgeInbox__']: [{ type: 'event', event: 'boot', data: { ready: true } }, 'not-json']
    };

    const bridge = createBridge({ global: globalObject, installGlobal: true });
    expect((globalObject['__wkbridgeInbox__'] as unknown[]).length).toBe(0);

    const received: unknown[] = [];
    bridge.on('boot', (payload) => received.push(payload));
    (globalObject['__wkbridge__'] as { receive: (payload: unknown) => void }).receive({
      type: 'event',
      event: 'boot',
      data: { ready: true }
    });

    expect(received).toEqual([{ ready: true }]);
  });

  test('ignores malformed payloads', () => {
    const { bridge } = createHarness();

    expect(() => bridge.receive('not-json')).not.toThrow();
    expect(() => bridge.receive(null)).not.toThrow();
    expect(() => bridge.receive([])).not.toThrow();
    expect(() => bridge.receive({ type: 'response', id: 'missing', ok: true })).not.toThrow();
    expect(() => bridge.receive({ type: 'unknown' })).not.toThrow();
    expect(bridge.pendingCount).toBe(0);
  });
});

describe('events', () => {
  test('delivers payloads to on listeners and removes them with off', () => {
    const { bridge } = createHarness();
    const received: unknown[] = [];
    const listener = (payload: unknown): void => {
      received.push(payload);
    };

    bridge.on('theme.changed', listener);
    bridge.receive({ type: 'event', event: 'theme.changed', data: { theme: 'dark' } });
    expect(received).toEqual([{ theme: 'dark' }]);

    bridge.off('theme.changed', listener);
    bridge.receive({ type: 'event', event: 'theme.changed', data: { theme: 'light' } });
    expect(received).toHaveLength(1);
  });

  test('unsubscribe returned by on stops delivery', () => {
    const { bridge } = createHarness();
    let count = 0;
    const unsubscribe = bridge.on('ping', () => {
      count += 1;
    });

    bridge.receive({ type: 'event', event: 'ping' });
    unsubscribe();
    bridge.receive({ type: 'event', event: 'ping' });

    expect(count).toBe(1);
  });

  test('once only fires a single time', () => {
    const { bridge } = createHarness();
    let count = 0;
    bridge.once('ready', () => {
      count += 1;
    });

    bridge.receive({ type: 'event', event: 'ready', data: 1 });
    bridge.receive({ type: 'event', event: 'ready', data: 2 });

    expect(count).toBe(1);
  });

  test('isolates listener errors and reports them', () => {
    const errors: Array<{ event: string; error: unknown }> = [];
    const globalObject: BridgeGlobal = {};
    const bridge = createBridge({
      transport: { postMessage(): void {} },
      global: globalObject,
      onListenerError: (error, event) => errors.push({ error, event })
    });

    let hits = 0;
    bridge.on('boom', () => {
      throw new Error('listener failed');
    });
    bridge.on('boom', () => {
      hits += 1;
    });

    expect(() => bridge.receive({ type: 'event', event: 'boom' })).not.toThrow();
    expect(hits).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.event).toBe('boom');
  });

  test('events without listeners are ignored', () => {
    const { bridge } = createHarness();
    expect(() => bridge.receive({ type: 'event', event: 'nobody' })).not.toThrow();
  });
});

describe('lifecycle', () => {
  test('destroy rejects pending calls and blocks further ones', async () => {
    const { bridge, globalObject } = createHarness();

    const pending = bridge.call('app.info');
    expect(bridge.pendingCount).toBe(1);

    bridge.destroy();
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.available).toBe(false);
    expect(globalObject['__wkbridge__']).toBeUndefined();

    const error = await pending.catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.DISPOSED);

    const later = await bridge.call('app.info').catch((reason: unknown) => reason);
    expect((later as BridgeError).code).toBe(ErrorCodes.DISPOSED);
  });

  test('destroy is idempotent and clears listeners', () => {
    const { bridge } = createHarness();
    let count = 0;
    bridge.on('ping', () => {
      count += 1;
    });

    bridge.destroy();
    bridge.destroy();
    bridge.receive({ type: 'event', event: 'ping' });

    expect(count).toBe(0);
  });
});
