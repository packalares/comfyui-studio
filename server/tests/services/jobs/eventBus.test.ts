// Tests for services/jobs/eventBus.ts

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  emit,
  subscribe,
  replay,
  listenerCount,
  _resetForTests,
  _sweepForTests,
} from '../../../src/services/jobs/eventBus.js';

beforeEach(() => _resetForTests());
afterEach(() => _resetForTests());

describe('JobEventBus: subscribe + emit', () => {
  it('delivers events to subscribed handler with monotonic seq', () => {
    const received: number[] = [];
    subscribe('pid1', (evt) => received.push(evt.seq));
    emit('pid1', { type: 'status', data: {} });
    emit('pid1', { type: 'progress', data: {} });
    expect(received).toEqual([0, 1]);
  });

  it('does not deliver to other promptIds', () => {
    const received: string[] = [];
    subscribe('pid-a', (evt) => received.push(evt.type));
    emit('pid-b', { type: 'done', data: {} });
    expect(received).toHaveLength(0);
  });

  it('unsubscribe stops delivery', () => {
    const received: number[] = [];
    const unsub = subscribe('pid2', (evt) => received.push(evt.seq));
    emit('pid2', { type: 'status', data: {} });
    unsub();
    emit('pid2', { type: 'done', data: {} });
    // Only the first event before unsub.
    expect(received).toEqual([0]);
  });
});

describe('JobEventBus: replay', () => {
  it('replay with afterSeq=-1 returns all events', () => {
    emit('replay1', { type: 'status', data: 'a' });
    emit('replay1', { type: 'progress', data: 'b' });
    const events = replay('replay1', -1);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
  });

  it('replay returns only events after the given seq', () => {
    emit('replay2', { type: 'status', data: 1 });
    emit('replay2', { type: 'progress', data: 2 });
    emit('replay2', { type: 'done', data: 3 });
    const events = replay('replay2', 0);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it('replay on unknown promptId returns empty array', () => {
    expect(replay('no-such-id', 0)).toEqual([]);
  });
});

describe('JobEventBus: listenerCount', () => {
  it('returns 0 with no subscribers', () => {
    expect(listenerCount('no-subs')).toBe(0);
  });

  it('tracks add and remove accurately', () => {
    const u1 = subscribe('lc', () => undefined);
    const u2 = subscribe('lc', () => undefined);
    expect(listenerCount('lc')).toBe(2);
    u1();
    expect(listenerCount('lc')).toBe(1);
    u2();
    expect(listenerCount('lc')).toBe(0);
  });
});

describe('JobEventBus: terminal purge via sweep timer', () => {
  it('purges entry after terminal event + 0 listeners + TTL elapsed', () => {
    // Use fake timers so we can control Date.now().
    vi.useFakeTimers();
    const now = Date.now();
    subscribe('term1', () => undefined)();  // subscribe then immediately unsub
    emit('term1', { type: 'done', data: {} });
    // Sanity: event is buffered.
    expect(replay('term1', -1)).toHaveLength(1);
    // Advance past TTL (5 min + 1s).
    vi.setSystemTime(now + 5 * 60 * 1000 + 1000);
    _sweepForTests();
    expect(listenerCount('term1')).toBe(0);
    expect(replay('term1', -1)).toHaveLength(0); // entry gone
    vi.useRealTimers();
  });

  it('does NOT purge entry while listeners are still attached', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const unsub = subscribe('term2', () => undefined);
    emit('term2', { type: 'error', data: {} });
    vi.setSystemTime(now + 6 * 60 * 1000);
    _sweepForTests();
    // Still has a listener → not purged.
    expect(replay('term2', -1)).toHaveLength(1);
    unsub();
    vi.useRealTimers();
  });
});

describe('JobEventBus: LRU cap', () => {
  it('evicts oldest entry when MAX_PROMPT_ENTRIES is exceeded', () => {
    // Create 500 entries (the cap).
    for (let i = 0; i < 500; i++) {
      emit(`lru-pid-${i}`, { type: 'status', data: i });
    }
    // Confirm the first entry still exists.
    expect(replay('lru-pid-0', -1)).toHaveLength(1);
    // Adding one more should evict the oldest (lru-pid-0).
    emit('lru-overflow', { type: 'status', data: 'new' });
    expect(replay('lru-pid-0', -1)).toHaveLength(0);
    // The overflow entry and the most-recent others should be there.
    expect(replay('lru-overflow', -1)).toHaveLength(1);
    expect(replay('lru-pid-499', -1)).toHaveLength(1);
  });
});
