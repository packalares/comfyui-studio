// Gallery service. Thin layer that glues the sqlite repo to ComfyUI.
//
// Wave F rewrote the event-driven path:
//  - `onExecutionComplete(promptId)` fetches one history entry, walks its
//    outputs, and appends rows via `appendFromHistory` (INSERT OR IGNORE).
//    User-deleted rows never come back because we don't rescan the whole
//    /api/history on every event.
//  - `syncFromComfyUI()` is kept only for the explicit "Import from
//    ComfyUI" endpoint. It walks history once, extracts metadata, and
//    appends. It does NOT wipe existing rows.
//  - The auto-seed path (`ensureSeeded` + `seedInFlight`) is gone.
//    Empty-gallery first boot now stays empty until the user generates
//    something or explicitly imports.
//
// Row `createdAt` is synthesised: ComfyUI's history has no per-output
// timestamp, so we use `Date.now() - index` for an import batch so
// newest-first ordering stays stable.

import fs from 'fs';
import path from 'path';
import { getGalleryItems, getHistoryForPrompt, deleteHistoryPrompts } from './comfyui.js';
import type { GalleryItem } from '../contracts/generation.contract.js';
import * as repo from '../lib/db/gallery.repo.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { safeResolve } from '../lib/fs.js';
import { buildRowsFromHistory, normalisePromptField } from './gallery.rowBuilder.js';

// Optional broadcaster for gallery-mutation WS notifications. `index.ts`
// installs this on boot via `setGalleryBroadcaster`. Tests + the CLI leave it
// null so mutations still succeed without a connected WS.
let broadcaster: ((message: object) => void) | null = null;

/** Installed by `index.ts` so service-level mutations can notify WS clients. */
export function setGalleryBroadcaster(fn: ((message: object) => void) | null): void {
  broadcaster = fn;
}

function emitGalleryUpdate(): void {
  if (!broadcaster) return;
  try {
    const items = repo.listAll({ sort: 'newest' });
    broadcaster({
      type: 'gallery',
      data: { total: items.length, recent: items.slice(0, 8) },
    });
  } catch (err) {
    logger.warn('gallery broadcast failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Event-driven single-row append. Called from the WS relay when ComfyUI
 * emits `execution_complete` for a specific prompt. Fetches that one
 * history entry, extracts metadata, and appends via INSERT OR IGNORE.
 * Returns the number of NEW rows written (0 when the files were already
 * recorded or when the history entry is missing).
 */
/**
 * Per-node append driven by ComfyUI's `executed` event. The event payload
 * carries `output: { images?: [...], gifs?: [...], audio?: [...], ... }`
 * inline for SaveImage-style nodes, so we can build the gallery row
 * directly without hitting `/api/history` (which has a persistence race
 * with the `executed` event itself and often returns stale outputs).
 *
 * Emits a single `gallery` broadcast per inserted node. Multiple rows
 * from a multi-output SaveImage fan out via `buildRowsFromHistory` with
 * a synthesised `outputs` map.
 */
export async function onNodeExecuted(
  promptId: string,
  output: Record<string, unknown>,
): Promise<number> {
  if (!promptId) return 0;
  const looksLikeFiles = (v: unknown): boolean => {
    if (!Array.isArray(v)) return false;
    return v.some((f) => f && typeof f === 'object' && typeof (f as { filename?: unknown }).filename === 'string');
  };
  const hasOutputFiles = Object.values(output).some(looksLikeFiles);
  if (!hasOutputFiles) return 0;
  try {
    // Feed the event payload through the same row-builder the history path
    // uses. `outputs` is keyed by node id in history, but for single-node
    // events we just need one synthetic bucket; the row id still combines
    // promptId + filename so dedup across `executed` bursts works.
    const rows = buildRowsFromHistory({
      promptId,
      outputs: { node: output as Record<string, unknown> },
      apiPrompt: null,
      createdAt: Date.now(),
    });
    let inserted = 0;
    for (const row of rows) {
      if (repo.appendFromHistory(row)) inserted += 1;
    }
    if (inserted > 0) emitGalleryUpdate();
    return inserted;
  } catch (err) {
    logger.warn('gallery onNodeExecuted failed', {
      promptId, message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Shared helper: fetch the single history entry for `promptId`, build rows,
 * append them, and broadcast once if anything was inserted. Reused by:
 *  - `onExecutionComplete` — the WS event path (`execution_success` / `execution_complete`).
 *  - `gallery.sentry` — the polling fallback that watches promptIds until
 *    outputs appear even when the WS path silently missed events.
 * Returns the number of NEW rows written.
 */
export async function appendHistoryEntry(promptId: string): Promise<number> {
  if (!promptId) return 0;
  try {
    const entry = await getHistoryForPrompt(promptId);
    if (!entry?.outputs) return 0;
    const rows = buildRowsFromHistory({
      promptId,
      outputs: entry.outputs,
      apiPrompt: normalisePromptField(entry.prompt),
      createdAt: Date.now(),
    });
    let inserted = 0;
    for (const row of rows) {
      if (repo.appendFromHistory(row)) inserted += 1;
    }
    if (inserted > 0) emitGalleryUpdate();
    return inserted;
  } catch (err) {
    logger.warn('gallery appendHistoryEntry failed', {
      promptId,
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export async function onExecutionComplete(promptId: string): Promise<number> {
  return appendHistoryEntry(promptId);
}

export interface ImportFromComfyUIResult {
  imported: number;
  skipped: number;
}

/**
 * Explicit "Import from ComfyUI history" path. Walks `/api/history`,
 * fetches each entry individually for the full prompt dict (the list
 * endpoint returns prompt too, but we re-fetch per-id to keep the
 * extraction path identical to `onExecutionComplete` and avoid
 * assumptions about the list response's `prompt` shape).
 *
 * Returns `{ imported, skipped }` where `skipped` counts rows that
 * already existed (INSERT OR IGNORE no-op).
 */
export async function syncFromComfyUI(): Promise<ImportFromComfyUIResult> {
  let imported = 0;
  let skipped = 0;
  try {
    const items = await getGalleryItems();
    const promptIds = Array.from(new Set(items.map(i => i.promptId).filter(Boolean)));
    const now = Date.now();
    let batchIdx = 0;
    for (const promptId of promptIds) {
      try {
        const entry = await getHistoryForPrompt(promptId);
        if (!entry?.outputs) continue;
        const rows = buildRowsFromHistory({
          promptId,
          outputs: entry.outputs,
          apiPrompt: normalisePromptField(entry.prompt),
          createdAt: now - batchIdx,
        });
        for (const row of rows) {
          if (repo.appendFromHistory(row)) imported += 1;
          else skipped += 1;
        }
      } catch (err) {
        logger.warn('gallery import: per-prompt fetch failed', {
          promptId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      batchIdx += 1;
    }
  } catch (err) {
    logger.warn('gallery sync failed', { message: err instanceof Error ? err.message : String(err) });
  }
  if (imported > 0) emitGalleryUpdate();
  return { imported, skipped };
}

export interface ListFilter {
  mediaType?: string;
  sort?: 'newest' | 'oldest';
}

/** Full list (non-paginated). Used when the route gets no ?page= param. */
export async function list(): Promise<GalleryItem[]> {
  return repo.listAll({ sort: 'newest' });
}

/** Paginated list. Filters applied at SQL level. */
export async function listPaginated(
  filter: ListFilter,
  page: number,
  pageSize: number,
): Promise<{ items: GalleryItem[]; total: number }> {
  return repo.listPaginated(
    { mediaType: filter.mediaType, sort: filter.sort === 'oldest' ? 'oldest' : 'newest' },
    page,
    pageSize,
  );
}

/** Remove a row by id (used by future delete endpoints). */
export function remove(id: string): boolean { return repo.remove(id); }

/** Single-row lookup — used by the regenerate endpoint. */
export function getById(id: string): GalleryItem | null { return repo.getById(id); }

export interface RemoveItemResult {
  id: string;
  removed: boolean;
  fileDeleted: boolean;
  promptId?: string;
  error?: string;
}

function removeItemInternal(id: string): RemoveItemResult {
  const row = repo.getById(id);
  if (!row) return { id, removed: false, fileDeleted: false, error: 'not-found' };

  let fileDeleted = false;
  let fileError: string | undefined;

  const outputRoot = env.COMFYUI_PATH
    ? path.join(env.COMFYUI_PATH, 'output')
    : '';
  if (outputRoot) {
    try {
      const segments: string[] = [];
      if (row.subfolder) segments.push(row.subfolder);
      segments.push(row.filename);
      const target = safeResolve(outputRoot, ...segments);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        fileDeleted = true;
      } else {
        logger.info('gallery removeItem: file already absent', {
          id, path: target,
        });
      }
    } catch (err) {
      fileError = err instanceof Error ? err.message : String(err);
      logger.warn('gallery removeItem: file delete failed', {
        id, error: fileError,
      });
    }
  }

  const removed = repo.remove(id);
  return {
    id,
    removed,
    fileDeleted,
    promptId: typeof row.promptId === 'string' && row.promptId.length > 0 ? row.promptId : undefined,
    error: fileError,
  };
}

/**
 * Remove a gallery item — delete both the sqlite row and the underlying file
 * on disk under `${COMFYUI_PATH}/output/<subfolder>/<filename>`. Missing files
 * (already gone) are logged + treated as success so the caller UI stays
 * consistent. Returns a structured result so bulk deletes can surface partial
 * failures without aborting. Broadcasts a `gallery` WS message on any change.
 */
export function removeItem(id: string): RemoveItemResult {
  const result = removeItemInternal(id);
  if (result.removed) {
    emitGalleryUpdate();
    if (result.promptId) void deleteHistoryPrompts([result.promptId]);
  }
  return result;
}

/**
 * Bulk delete. Collects per-id results so the route can surface partial
 * failures and emits a single `gallery` broadcast after the batch completes.
 */
export function removeItems(ids: string[]): RemoveItemResult[] {
  const results: RemoveItemResult[] = [];
  for (const id of ids) results.push(removeItemInternal(id));
  if (results.some(r => r.removed)) {
    emitGalleryUpdate();
    const promptIds = Array.from(new Set(
      results.filter(r => r.removed && r.promptId).map(r => r.promptId as string),
    ));
    if (promptIds.length > 0) void deleteHistoryPrompts(promptIds);
  }
  return results;
}
