// Gallery sentry — WS-queue-driven safety net for the event path.
//
// Previous implementation polled `/api/history/:promptId` on escalating
// intervals (2-4-8-...-240s). That delayed auto-refresh by ~40-60s on the
// common case where ComfyUI's `execution_success` event didn't reach us.
//
// Current implementation: no timers, no periodic polling. We just maintain
// a Set of promptIds we're "watching" (added when a prompt is submitted).
// When the WS relay sees a `queue` status update from ComfyUI, we check
// which watched promptIds are no longer in running ∪ pending — those have
// just finished, so we immediately call `appendHistoryEntry` once for each
// and remove them from the watch set.
//
// `appendHistoryEntry` is idempotent (INSERT ON CONFLICT DO UPDATE with
// COALESCE), so firing it again from the event path is harmless.
//
// `hydrateFromQueue()` on boot populates the watch set from ComfyUI's
// `/api/queue` so Studio restarts mid-run still catch completions.

import { fetchComfyUI } from './comfyui.js';
import { appendHistoryEntry } from './gallery.service.js';
import * as repo from '../lib/db/gallery.repo.js';
import { logger } from '../lib/logger.js';

const watched = new Set<string>();

/** Add a promptId to the watch set. Called after a successful submit. */
export function schedulePromptWatch(promptId: string): void {
  if (!promptId) return;
  watched.add(promptId);
}

/**
 * Called from the WS relay on every `queue` message. `activeIds` is the union
 * of queue_running + queue_pending promptIds. Any watched promptId not in
 * that set has just finished — we fetch its history once, append, and clear.
 */
export async function onQueueStatus(activeIds: Set<string>): Promise<void> {
  const finished: string[] = [];
  for (const pid of watched) {
    if (!activeIds.has(pid)) finished.push(pid);
  }
  if (finished.length === 0) return;
  for (const pid of finished) watched.delete(pid);
  for (const pid of finished) {
    try {
      const inserted = await appendHistoryEntry(pid);
      if (inserted === 0) {
        // History may not be flushed yet — one short retry at 500ms catches
        // the common race without a full polling loop.
        setTimeout(() => {
          void appendHistoryEntry(pid).catch((err) => {
            logger.warn('gallery sentry: retry append failed', {
              promptId: pid,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        }, 500);
      }
    } catch (err) {
      logger.warn('gallery sentry: append threw', {
        promptId: pid,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Test-only: clear the watch set. */
export function _cancelAllWatchesForTests(): void {
  watched.clear();
}

/**
 * On boot (or after ComfyUI comes back up) hydrate the watch set from
 * ComfyUI's queue. Any id already in our gallery sqlite is skipped so we
 * don't re-append rows that already landed.
 */
export async function hydrateFromQueue(): Promise<void> {
  let queue: { queue_running: unknown[]; queue_pending: unknown[] };
  try {
    queue = await fetchComfyUI<{
      queue_running: unknown[]; queue_pending: unknown[];
    }>('/api/queue');
  } catch (err) {
    logger.warn('gallery sentry: hydrateFromQueue fetch failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const entries = [
    ...(queue.queue_running ?? []),
    ...(queue.queue_pending ?? []),
  ];
  let scheduled = 0;
  for (const raw of entries) {
    if (!Array.isArray(raw)) continue;
    const pid = raw[1];
    if (typeof pid !== 'string' || pid.length === 0) continue;
    if (await hasRowForPrompt(pid)) continue;
    watched.add(pid);
    scheduled += 1;
  }
  if (scheduled > 0) {
    logger.info('gallery sentry: hydrated from queue', { scheduled });
  }
}

async function hasRowForPrompt(promptId: string): Promise<boolean> {
  try {
    const all = repo.listAll({ sort: 'newest' });
    return all.some(r => r.promptId === promptId);
  } catch {
    return false;
  }
}
