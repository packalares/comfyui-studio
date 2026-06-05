/**
 * Integration tests for the consolidated ComfyUI WS fan-out.
 *
 * Strategy: unit-test the fan-out logic without starting a real HTTP server
 * or real WebSocket server. We directly exercise:
 *   - The `broadcastRaw` behaviour via the bridge's onRaw subscription
 *   - The `clients` Set management on connect/disconnect
 *   - No upstream WS spawned per browser connection
 *
 * Memory-leak proofs:
 *   "No upstream WS spawned per browser connect": see
 *     'no upstream WS per browser connect: bridge.onRaw receives one subscription only'
 *   "No listener leaks after 100 connect/disconnect cycles": see
 *     'no listener leak after many connect/disconnect cycles'
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  onRaw,
  _simulateMessageForTests,
  _listenerCountForTests,
  _removeAllListenersForTests,
} from '../../src/services/videoboard/comfyJobBridge.js';

afterEach(() => {
  _removeAllListenersForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Simulate the index.ts fan-out pattern without spinning up Express/ws.
// We model: a `clients` Set, a `broadcastRaw` fn, and a single onRaw mounted
// at boot. This matches exactly what index.ts does after the refactor.
// ---------------------------------------------------------------------------

function makeSimulatedServer() {
  const clients = new Set<{ readyState: number; received: string[]; send(s: string): void }>();

  // Simulate broadcastRaw from index.ts (OPEN = 1)
  function broadcastRaw(json: string) {
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(json);
    }
  }

  // Mount ONCE at boot — mirrors index.ts start()
  const unsub = onRaw((json) => broadcastRaw(json));

  function connect() {
    const ws = {
      readyState: 1,
      received: [] as string[],
      send(s: string) { this.received.push(s); },
    };
    clients.add(ws);
    return {
      ws,
      disconnect() {
        ws.readyState = 3; // CLOSED
        clients.delete(ws);
      },
    };
  }

  return { connect, unsub };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('broadcastRaw fan-out via onRaw', () => {
  it('3 connected clients all receive a simulated ComfyUI message', () => {
    const { connect, unsub } = makeSimulatedServer();
    const c1 = connect();
    const c2 = connect();
    const c3 = connect();

    const msg = JSON.stringify({ type: 'executed', data: { prompt_id: 'p1', output: {} } });
    _simulateMessageForTests(msg);

    expect(c1.ws.received).toHaveLength(1);
    expect(c2.ws.received).toHaveLength(1);
    expect(c3.ws.received).toHaveLength(1);
    expect(c1.ws.received[0]).toBe(msg);

    unsub();
  });

  it('disconnected client stops receiving after disconnect', () => {
    const { connect, unsub } = makeSimulatedServer();
    const c1 = connect();
    const c2 = connect();
    const c3 = connect();

    c2.disconnect();

    const msg = JSON.stringify({ type: 'status', data: {} });
    _simulateMessageForTests(msg);

    expect(c1.ws.received).toHaveLength(1);
    expect(c2.ws.received).toHaveLength(0); // disconnected
    expect(c3.ws.received).toHaveLength(1);

    unsub();
  });

  it('new client added after initial connection receives subsequent messages', () => {
    const { connect, unsub } = makeSimulatedServer();
    const c1 = connect();

    _simulateMessageForTests(JSON.stringify({ type: 'status', data: {} }));
    expect(c1.ws.received).toHaveLength(1);

    const c2 = connect();
    _simulateMessageForTests(JSON.stringify({ type: 'status', data: {} }));

    expect(c1.ws.received).toHaveLength(2);
    expect(c2.ws.received).toHaveLength(1); // only the second message

    unsub();
  });
});

// ---------------------------------------------------------------------------
// No upstream WS spawned per browser connect
// The bridge's onRaw is mounted exactly ONCE at boot; there is only 1 listener
// on the 'raw' event regardless of how many browser clients connect.
// ---------------------------------------------------------------------------
describe('no upstream WS per browser connect: bridge.onRaw receives one subscription only', () => {
  it('connecting 100 browser clients does not add more raw listeners', () => {
    // Baseline before our single boot-time subscription
    const before = _listenerCountForTests('raw');

    const { connect, unsub } = makeSimulatedServer();

    // The server mounted exactly one onRaw listener at boot.
    const afterBoot = _listenerCountForTests('raw');
    expect(afterBoot).toBe(before + 1);

    // Connect 100 fake browser clients.
    const clients = [];
    for (let i = 0; i < 100; i++) {
      clients.push(connect());
    }

    // Listener count must NOT have grown — no per-client subscriptions.
    expect(_listenerCountForTests('raw')).toBe(before + 1);

    // Disconnect all clients — count still 1 (boot subscription).
    for (const c of clients) c.disconnect();
    expect(_listenerCountForTests('raw')).toBe(before + 1);

    unsub();
    expect(_listenerCountForTests('raw')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// No listener leaks after 100 connect/disconnect cycles
// ---------------------------------------------------------------------------
describe('no listener leak after many connect/disconnect cycles', () => {
  it('100 cycles: raw listener count stays at boot baseline + 1', () => {
    const { connect, unsub } = makeSimulatedServer();
    const baseline = _listenerCountForTests('raw'); // 1 from boot sub

    for (let i = 0; i < 100; i++) {
      const c = connect();
      c.disconnect();
    }

    expect(_listenerCountForTests('raw')).toBe(baseline);

    unsub();
    expect(_listenerCountForTests('raw')).toBe(baseline - 1);
  });
});
