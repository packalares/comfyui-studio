// Read the status of a ComfyUI generation job from available sources.
// Priority: in-memory bridge state → ComfyUI /history → gallery DB.

import { getHistoryForPrompt, getQueuePromptIds } from '../comfyui/api.js';
import { listByPromptIds } from '../../lib/db/gallery.repo.js';
import type { JobStatus } from '../../contracts/jobs.contract.js';
import type { GalleryItemRef } from '../../contracts/jobs.contract.js';

// Parsed status block from ComfyUI /history/:promptId.
interface ComfyHistoryStatus {
  messages?: Array<[string, unknown]>;
}

function pickStatusFromHistory(status: ComfyHistoryStatus | undefined): 'success' | 'failed' {
  if (!status?.messages) return 'success';
  const hasError = status.messages.some((m) => Array.isArray(m) && m[0] === 'execution_error');
  return hasError ? 'failed' : 'success';
}

/**
 * Consolidate job state from the fastest available source.
 * Returns null when nothing is known about this promptId.
 */
export async function getJobStatus(promptId: string): Promise<JobStatus | null> {
  const now = Date.now();

  // 1. Check ComfyUI live queue — tells us queued vs running instantly.
  let activeIds: Set<string> | null = null;
  try {
    activeIds = await getQueuePromptIds();
  } catch {
    // ComfyUI unreachable; fall through to history + gallery.
  }

  if (activeIds !== null) {
    if (activeIds.has(promptId)) {
      // Prompt is in the active queue (pending or running).
      return {
        id: promptId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  // 2. Check ComfyUI /history for completed-but-not-yet-in-gallery prompts.
  type HistoryEntry = Exclude<Awaited<ReturnType<typeof getHistoryForPrompt>>, null>;
  let historyEntry: HistoryEntry | undefined;
  try {
    const h = await getHistoryForPrompt(promptId);
    historyEntry = h ?? undefined;
  } catch {
    // History unreachable; try gallery next.
  }

  // 3. Check gallery DB — has items for this prompt when sentry has committed them.
  const galleryRows = listByPromptIds([promptId]);

  if (galleryRows.length > 0) {
    // Gallery is the ground truth for terminal state once sentry has inserted.
    const firstRow = galleryRows[0];
    const terminalStatus = historyEntry
      ? pickStatusFromHistory(historyEntry.status as ComfyHistoryStatus | undefined)
      : 'success';
    const items: GalleryItemRef[] = galleryRows.map((r) => ({
      id: r.id,
      filename: r.filename,
      mediaType: r.mediaType,
      url: r.url,
      promptId: r.promptId,
    }));
    const ts = firstRow.createdAt ?? now;
    return {
      id: promptId,
      status: terminalStatus,
      result: terminalStatus === 'success' ? { items } : undefined,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  if (historyEntry !== undefined) {
    // Prompt ran (has history) but gallery hasn't written the row yet.
    const terminalStatus = pickStatusFromHistory(
      historyEntry.status as ComfyHistoryStatus | undefined,
    );
    const errMsg = terminalStatus === 'failed'
      ? extractErrorFromHistory(historyEntry.status as ComfyHistoryStatus | undefined)
      : undefined;
    return {
      id: promptId,
      status: terminalStatus,
      error: errMsg ? { code: 'execution_error', message: errMsg } : undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Nothing known. If ComfyUI was reachable and the prompt isn't in queue or
  // history, it was never submitted (or was submitted to a different process).
  if (activeIds !== null) {
    return null;
  }

  // ComfyUI was unreachable and gallery has no row — truly unknown.
  return null;
}

function extractErrorFromHistory(status: ComfyHistoryStatus | undefined): string | undefined {
  if (!status?.messages) return undefined;
  for (const m of status.messages) {
    if (Array.isArray(m) && m[0] === 'execution_error') {
      const details = m[1];
      if (details && typeof details === 'object') {
        const d = details as Record<string, unknown>;
        const msg = d['exception_message'] ?? d['exception_type'];
        return typeof msg === 'string' ? msg : undefined;
      }
    }
  }
  return undefined;
}
