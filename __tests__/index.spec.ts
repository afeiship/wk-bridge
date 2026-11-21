import { describe, expect, test } from 'bun:test';
import createBridgeDefault, {
  BridgeError,
  ErrorCodes,
  VERSION,
  createBridge,
  createMockBridge
} from '../src';

describe('package exports', () => {
  test('exposes the bridge factories and helpers', () => {
    expect(typeof createBridge).toBe('function');
    expect(typeof createMockBridge).toBe('function');
    expect(typeof createBridgeDefault).toBe('function');
    expect(typeof BridgeError).toBe('function');
    expect(VERSION).toBe('1.0.0');
    expect(ErrorCodes.TIMEOUT).toBe('TIMEOUT');
  });

  test('mock bridge satisfies the same contract as the real bridge', async () => {
    const bridge = createMockBridge({
      'app.ping': () => 'pong'
    });

    expect(bridge.version).toBe(VERSION);
    expect(await bridge.call('app.ping')).toBe('pong');
  });
});
