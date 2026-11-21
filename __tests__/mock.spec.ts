import { describe, expect, test } from 'bun:test';
import { BridgeError, ErrorCodes, createMockBridge } from '../src';

describe('createMockBridge', () => {
  test('resolves handler results and records requests', async () => {
    const bridge = createMockBridge({
      'app.info': () => ({ platform: 'browser', version: 'dev' }),
      'math.add': (params: { a: number; b: number }) => params.a + params.b
    });

    expect(bridge.available).toBe(true);
    expect(await bridge.call('math.add', { a: 2, b: 3 })).toBe(5);

    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]).toMatchObject({ method: 'math.add', params: { a: 2, b: 3 } });
  });

  test('converts undefined results to null', async () => {
    const bridge = createMockBridge({
      'noop.run': () => undefined
    });

    expect(await bridge.call('noop.run')).toBeNull();
  });

  test('rejects unknown methods with UNKNOWN_METHOD', async () => {
    const bridge = createMockBridge({});

    const error = await bridge.call('missing.method').catch((reason: unknown) => reason);
    expect(BridgeError.is(error)).toBe(true);
    expect((error as BridgeError).code).toBe(ErrorCodes.UNKNOWN_METHOD);
    expect((error as BridgeError).method).toBe('missing.method');
  });

  test('keeps code, message and data from a thrown BridgeError', async () => {
    const bridge = createMockBridge({
      'auth.login': (params: { username?: string }) => {
        if (!params.username) {
          throw new BridgeError('invalid_params', 'username is required', {
            data: { field: 'username' }
          });
        }
        return { token: 'mock-token' };
      }
    });

    const error = await bridge.call('auth.login', {}).catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe('invalid_params');
    expect((error as BridgeError).message).toBe('username is required');
    expect((error as BridgeError).data).toEqual({ field: 'username' });
  });

  test('maps unexpected throws to HANDLER_ERROR', async () => {
    const bridge = createMockBridge({
      'demo.boom': () => {
        throw new Error('handler exploded');
      }
    });

    const error = await bridge.call('demo.boom').catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.HANDLER_ERROR);
    expect((error as BridgeError).message).toBe('handler exploded');
  });

  test('supports emit on the bridge and on the handler context', async () => {
    const bridge = createMockBridge({
      'demo.boot': (
        _params: unknown,
        context: { emit: (event: string, payload: unknown) => void }
      ) => {
        context.emit('demo.booted', { at: 1 });
        return 'booted';
      }
    });

    const events: unknown[] = [];
    bridge.on('demo.booted', (payload: unknown) => events.push(payload));
    bridge.on('demo.external', (payload: unknown) => events.push(payload));

    await bridge.call('demo.boot');
    bridge.emit('demo.external', { at: 2 });

    expect(events).toEqual([{ at: 1 }, { at: 2 }]);
  });

  test('honours simulated latency', async () => {
    const bridge = createMockBridge(
      {
        'demo.slow': () => 'done'
      },
      { latency: 20 }
    );

    const startedAt = Date.now();
    const result = await bridge.call('demo.slow');
    expect(result).toBe('done');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  test('still enforces the timeout against slow handlers', async () => {
    const bridge = createMockBridge(
      {
        'demo.slow': () => 'done'
      },
      { latency: 50, timeout: 10 }
    );

    const error = await bridge.call('demo.slow').catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.TIMEOUT);
    expect(bridge.pendingCount).toBe(0);
  });

  test('destroy stops further mock calls', async () => {
    const bridge = createMockBridge({
      'app.info': () => ({ platform: 'browser' })
    });

    bridge.destroy();
    const error = await bridge.call('app.info').catch((reason: unknown) => reason);
    expect((error as BridgeError).code).toBe(ErrorCodes.DISPOSED);
  });
});
