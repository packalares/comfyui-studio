// Unit tests for the gallery-sentry polling fallback.
//
// The sentry watches a promptId on an escalating timer (2s, 4s, 8s, 15s, …)
// and calls `appendHistoryEntry` each tick until outputs land or the watch
// times out. We use `vi.useFakeTimers()` to fast-forward through the
// cadence, and a `fetch` stub to decide when ComfyUI history starts
// returning outputs.
//
// `appendHistoryEntry` is awaited inside the timer callback, so each tick's
// advancement needs to let the microtask queue drain before the next
// `vi.advanceTimersByTimeAsync` call. vitest's `advanceTimersByTimeAsync`
// already does that; see the per-test loops.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  schedulePromptWatch,
  hydrateFromQueue,
  _cancelAllWatchesForTests,
} from '../../src/services/gallery.sentry.js';
import * as repo from '../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

// Mirrors the POLL_INTERVALS_MS array in `gallery.sentry.ts`. Keep in sync —
// if production intervals change, update both.
const POLL_INTERVALS_MS = [
  2_000, 4_000, 8_000, 15_000, 25_000,
  40_000, 60_000, 90_000, 120_000, 180_000, 240_000,
];

const HISTORY_OUTPUTS = {
  '7': {
    images: [{ filename: 'out.png', subfolder: '', type: 'output' }],
  },
};
const HISTORY_PROMPT = [0, 'p1', {
  '5': {
    class_type: 'KSampler',
    inputs: { seed: 42, steps: 10, cfg: 5, sampler_name: 'euler' },
  },
}, {}, []];

describe('gallery.sentry', () => {
  useFreshDb();

  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    _cancelAllWatchesForTests();
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  async function runThroughIntervals(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVALS_MS[i]);
    }
  }

  it('appends rows + broadcasts once when outputs appear after a few polls', async () => {
    // First 2 history fetches: no outputs yet. Third: outputs present.
    let historyFetchCount = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/history/p1')) {
        historyFetchCount += 1;
        if (historyFetchCount < 3) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(JSON.stringify({
          p1: { prompt: HISTORY_PROMPT, outputs: HISTORY_OUTPUTS },
        }), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;

    schedulePromptWatch('p1');
    await runThroughIntervals(3); // 2s + 4s + 8s
    expect(historyFetchCount).toBe(3);
    expect(repo.count()).toBe(1);
    const row = repo.getById('p1-out.png');
    expect(row?.promptId).toBe('p1');
    expect(row?.seed).toBe(42);
  });

  it('dedupes: a second schedulePromptWatch call for an in-flight id is a no-op', async () => {
    let historyFetchCount = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/history/p2')) {
        historyFetchCount += 1;
        // Never return outputs — force timeouts so we can count polls.
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;

    schedulePromptWatch('p2');
    schedulePromptWatch('p2'); // dedup — must not spawn a second timer chain.
    await runThroughIntervals(3); // run three ticks.
    // If dedup failed we'd see 6 fetches (two chains). With dedup: exactly 3.
    expect(historyFetchCount).toBe(3);
  });

  it('drops the watch after the final timeout without writing anything', async () => {
    let historyFetchCount = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/history/p3')) {
        historyFetchCount += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;

    schedulePromptWatch('p3');
    // Run through EVERY scheduled interval. On the last tick the watch
    // drops itself (no more intervals queued).
    await runThroughIntervals(POLL_INTERVALS_MS.length);
    expect(historyFetchCount).toBe(POLL_INTERVALS_MS.length);
    expect(repo.count()).toBe(0);

    // After timeout: scheduling the same id again is allowed (it's no
    // longer in the in-flight map). We don't need to advance timers to
    // prove this — just check that the call doesn't throw.
    expect(() => schedulePromptWatch('p3')).not.toThrow();
  });

  it('hydrateFromQueue schedules a watch per running/pending promptId not in gallery', async () => {
    // Seed one of the three prompts into the gallery so it's skipped.
    repo.insert({
      id: 'p-already-in-gallery-out.png',
      filename: 'out.png', subfolder: '', type: 'output',
      mediaType: 'image', url: '/api/view?filename=out.png',
      promptId: 'p-already-in-gallery',
      createdAt: 1000,
    });

    const queuePayload = {
      queue_running: [[0, 'p-running', {}]],
      queue_pending: [
        [1, 'p-pending-1', {}],
        [2, 'p-already-in-gallery', {}],
      ],
    };

    const historyCalls: string[] = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/queue')) {
        return new Response(JSON.stringify(queuePayload), { status: 200 });
      }
      if (u.includes('/api/history/')) {
        const pid = u.split('/api/history/')[1].replace(/\?.*$/, '');
        historyCalls.push(pid);
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;

    await hydrateFromQueue();
    // Advance one poll interval (2s) so each scheduled watch fires once.
    await vi.advanceTimersByTimeAsync(POLL_INTERVALS_MS[0]);

    // We expect exactly the two uncovered promptIds to have triggered a
    // history fetch; the already-in-gallery one must have been skipped.
    expect(historyCalls.sort()).toEqual(['p-pending-1', 'p-running']);
  });
});
