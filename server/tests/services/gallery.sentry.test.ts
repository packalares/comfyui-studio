// Unit tests for the gallery-sentry WS-queue-driven fallback.
//
// The sentry now uses `schedulePromptWatch` to add a promptId to a watch set,
// and `onQueueStatus` to trigger appends when a watched id disappears from
// the active queue. Timer-based polling was removed; these tests drive the
// new event-driven path directly.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  schedulePromptWatch,
  onQueueStatus,
  hydrateFromQueue,
  _cancelAllWatchesForTests,
} from '../../src/services/gallery/sentry.js';
import * as repo from '../../src/lib/db/gallery.repo.js';
import { useFreshDb } from '../lib/db/_helpers.js';

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

  it('appends rows + broadcasts once when outputs appear after onQueueStatus', async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/history/p1')) {
        return new Response(JSON.stringify({
          p1: { prompt: HISTORY_PROMPT, outputs: HISTORY_OUTPUTS },
        }), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;

    schedulePromptWatch('p1');
    // p1 is still in the active set — no append yet.
    await onQueueStatus(new Set(['p1']));
    expect(repo.count()).toBe(0);

    // p1 leaves the queue — sentry appends.
    await onQueueStatus(new Set());
    expect(repo.count()).toBe(1);
    const row = repo.listAll().find(r => r.promptId === 'p1');
    expect(row?.promptId).toBe('p1');
  });

  it('dedupes: a second schedulePromptWatch call for an in-flight id is a no-op', async () => {
    let fetchCount = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/history/p2')) {
        fetchCount += 1;
        return new Response(JSON.stringify({
          p2: { prompt: HISTORY_PROMPT, outputs: HISTORY_OUTPUTS },
        }), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;

    schedulePromptWatch('p2');
    schedulePromptWatch('p2'); // dedup — no-op
    await onQueueStatus(new Set()); // triggers append
    // Only one append call — dedup prevents double-insert.
    expect(fetchCount).toBe(1);
    expect(repo.count()).toBe(1);
  });

  it('drops the watch when onQueueStatus triggers it — subsequent re-watch is allowed', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;

    schedulePromptWatch('p3');
    await onQueueStatus(new Set()); // triggers; no outputs so 0 rows
    expect(repo.count()).toBe(0);

    // After trigger the id is removed from the watch set.
    // Re-scheduling the same id must NOT throw.
    expect(() => schedulePromptWatch('p3')).not.toThrow();
  });

  it('hydrateFromQueue schedules a watch per running/pending promptId not in gallery', async () => {
    // Seed one of the three prompts into the gallery so it is skipped.
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
        const pid = u.split('/api/history/')[1]?.replace(/\?.*$/, '') ?? '';
        historyCalls.push(pid);
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response('not-found', { status: 404 });
    }) as unknown as typeof fetch;

    await hydrateFromQueue();
    // Trigger the two newly-watched prompts via onQueueStatus.
    await onQueueStatus(new Set());
    historyCalls.sort();
    expect(historyCalls).toEqual(['p-pending-1', 'p-running']);
  });
});
