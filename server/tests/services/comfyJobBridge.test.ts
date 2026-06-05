/**
 * Unit tests for comfyJobBridge subscription API.
 *
 * Memory-leak assertions:
 *   - "Listener count returns to baseline after 1000 sub/unsub":
 *     see 'subscription API: listener count returns to baseline after 1000 sub/unsub'
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  onRaw,
  onStatus,
  onExecuted,
  onExecutionComplete,
  _simulateMessageForTests,
  _listenerCountForTests,
  _removeAllListenersForTests,
} from '../../src/services/videoboard/comfyJobBridge.js';

afterEach(() => {
  _removeAllListenersForTests();
});

// ---------------------------------------------------------------------------
// onRaw
// ---------------------------------------------------------------------------
describe('subscription API: onRaw', () => {
  it('fires handler with the raw JSON string', () => {
    const received: string[] = [];
    onRaw((json) => received.push(json));
    const msg = JSON.stringify({ type: 'status', data: {} });
    _simulateMessageForTests(msg);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(msg);
  });

  it('unsubscribe stops delivery', () => {
    const received: string[] = [];
    const unsub = onRaw((json) => received.push(json));
    const msg = JSON.stringify({ type: 'status', data: {} });
    _simulateMessageForTests(msg);
    expect(received).toHaveLength(1);
    unsub();
    _simulateMessageForTests(msg);
    expect(received).toHaveLength(1); // no new delivery after unsub
  });

  it('fires for non-JSON frames without throwing (non-JSON strings are dropped before emit)', () => {
    const received: string[] = [];
    onRaw((json) => received.push(json));
    // Non-JSON: handleComfyMessage returns early before emitting 'raw'
    _simulateMessageForTests('not-json-at-all');
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// onStatus
// ---------------------------------------------------------------------------
describe('subscription API: onStatus', () => {
  it('fires on status messages', () => {
    let count = 0;
    onStatus(() => { count++; });
    _simulateMessageForTests(JSON.stringify({ type: 'status', data: {} }));
    expect(count).toBe(1);
  });

  it('does not fire on non-status messages', () => {
    let count = 0;
    onStatus(() => { count++; });
    _simulateMessageForTests(JSON.stringify({ type: 'executed', data: { prompt_id: 'p1', output: {} } }));
    expect(count).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    let count = 0;
    const unsub = onStatus(() => { count++; });
    _simulateMessageForTests(JSON.stringify({ type: 'status', data: {} }));
    unsub();
    _simulateMessageForTests(JSON.stringify({ type: 'status', data: {} }));
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onExecuted
// ---------------------------------------------------------------------------
describe('subscription API: onExecuted', () => {
  it('fires with promptId and output on executed messages', () => {
    const results: Array<{ promptId: string; output: Record<string, unknown> }> = [];
    onExecuted((promptId, output) => results.push({ promptId, output }));
    _simulateMessageForTests(
      JSON.stringify({ type: 'executed', data: { prompt_id: 'abc', output: { images: ['img1'] } } }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.promptId).toBe('abc');
    expect(results[0]?.output).toEqual({ images: ['img1'] });
  });

  it('does not fire on non-executed messages', () => {
    let count = 0;
    onExecuted(() => { count++; });
    _simulateMessageForTests(JSON.stringify({ type: 'status', data: {} }));
    expect(count).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    let count = 0;
    const unsub = onExecuted(() => { count++; });
    _simulateMessageForTests(
      JSON.stringify({ type: 'executed', data: { prompt_id: 'x1', output: {} } }),
    );
    unsub();
    _simulateMessageForTests(
      JSON.stringify({ type: 'executed', data: { prompt_id: 'x2', output: {} } }),
    );
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// onExecutionComplete
// ---------------------------------------------------------------------------
describe('subscription API: onExecutionComplete', () => {
  it('fires with promptId on execution_success', () => {
    const ids: string[] = [];
    onExecutionComplete((id) => ids.push(id));
    _simulateMessageForTests(
      JSON.stringify({ type: 'execution_success', data: { prompt_id: 'done1' } }),
    );
    expect(ids).toEqual(['done1']);
  });

  it('fires with promptId on execution_complete', () => {
    const ids: string[] = [];
    onExecutionComplete((id) => ids.push(id));
    _simulateMessageForTests(
      JSON.stringify({ type: 'execution_complete', data: { prompt_id: 'done2' } }),
    );
    expect(ids).toEqual(['done2']);
  });

  it('does not fire on other message types', () => {
    let count = 0;
    onExecutionComplete(() => { count++; });
    _simulateMessageForTests(JSON.stringify({ type: 'executed', data: { prompt_id: 'p', output: {} } }));
    expect(count).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    let count = 0;
    const unsub = onExecutionComplete(() => { count++; });
    _simulateMessageForTests(
      JSON.stringify({ type: 'execution_success', data: { prompt_id: 'e1' } }),
    );
    unsub();
    _simulateMessageForTests(
      JSON.stringify({ type: 'execution_success', data: { prompt_id: 'e2' } }),
    );
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Listener count / memory leak: 1000 sub+unsub returns to baseline
// ---------------------------------------------------------------------------
describe('subscription API: listener count returns to baseline after 1000 sub/unsub', () => {
  it('raw: 1000 subscribe+unsubscribe → count back to 0', () => {
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < 1000; i++) {
      unsubs.push(onRaw(() => { /* noop */ }));
    }
    expect(_listenerCountForTests('raw')).toBe(1000);
    for (const u of unsubs) u();
    expect(_listenerCountForTests('raw')).toBe(0);
  });

  it('status: 1000 subscribe+unsubscribe → count back to 0', () => {
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < 1000; i++) {
      unsubs.push(onStatus(() => { /* noop */ }));
    }
    expect(_listenerCountForTests('status')).toBe(1000);
    for (const u of unsubs) u();
    expect(_listenerCountForTests('status')).toBe(0);
  });

  it('executed: 1000 subscribe+unsubscribe → count back to 0', () => {
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < 1000; i++) {
      unsubs.push(onExecuted(() => { /* noop */ }));
    }
    expect(_listenerCountForTests('executed')).toBe(1000);
    for (const u of unsubs) u();
    expect(_listenerCountForTests('executed')).toBe(0);
  });

  it('executionComplete: 1000 subscribe+unsubscribe → count back to 0', () => {
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < 1000; i++) {
      unsubs.push(onExecutionComplete(() => { /* noop */ }));
    }
    expect(_listenerCountForTests('executionComplete')).toBe(1000);
    for (const u of unsubs) u();
    expect(_listenerCountForTests('executionComplete')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fanToEventBus still fires for untracked prompts (previous fix preserved)
// ---------------------------------------------------------------------------
describe('fanToEventBus: fires for prompts not in tracked map', () => {
  it('onExecutionComplete fires for a prompt that was never tracked', () => {
    const ids: string[] = [];
    onExecutionComplete((id) => ids.push(id));
    // This prompt was never passed to trackComfyPrompt; fanToEventBus runs first.
    _simulateMessageForTests(
      JSON.stringify({ type: 'execution_success', data: { prompt_id: 'untracked-123' } }),
    );
    // The typed subscription event should still have fired.
    expect(ids).toEqual(['untracked-123']);
  });
});

// ---------------------------------------------------------------------------
// Multiple subscribers receive the same message
// ---------------------------------------------------------------------------
describe('subscription API: multiple subscribers', () => {
  it('both onRaw handlers fire for the same message', () => {
    const a: string[] = [];
    const b: string[] = [];
    onRaw((j) => a.push(j));
    onRaw((j) => b.push(j));
    const msg = JSON.stringify({ type: 'status', data: {} });
    _simulateMessageForTests(msg);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toBe(b[0]);
  });
});
