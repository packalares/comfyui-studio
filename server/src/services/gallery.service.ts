// Gallery service — glues the sqlite repo to ComfyUI history events.

import fs from 'fs';
import path from 'path';
import { getGalleryItems, getHistoryForPrompt, deleteHistoryPrompts } from './comfyui.js';
import type { GalleryItem, GalleryListItem } from '../contracts/generation.contract.js';
import * as repo from '../lib/db/gallery.repo.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { safeResolve } from '../lib/fs.js';
import { buildRowsFromHistory, normalisePromptField } from './gallery.rowBuilder.js';
import { getPromptMeta, clearPromptMeta } from './gallery.promptMeta.js';
import { getSnapshot, deleteSnapshot } from '../lib/db/promptSnapshots.repo.js';

// Optional broadcaster for gallery-mutation WS notifications.
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

/** Per-node append from ComfyUI's `executed` event (inline output payload). */
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
 * Fetch history for `promptId`, build rows, append, and broadcast.
 * Falls back to the submit-time snapshot when history is missing.
 * Returns the number of NEW rows written.
 */
export async function appendHistoryEntry(promptId: string): Promise<number> {
  if (!promptId) return 0;
  try {
    const meta = getPromptMeta(promptId);
    const entry = await getHistoryForPrompt(promptId);
    // When outputs are absent, snapshot can't help yet — caller will retry.
    if (!entry?.outputs) return 0;
    let apiPrompt = normalisePromptField(entry.prompt);
    if (!apiPrompt) {
      const snap = getSnapshot(promptId);
      if (snap) { try { apiPrompt = JSON.parse(snap.apiPromptJson) as typeof apiPrompt; } catch { /* ignore */ } }
    }
    const rows = buildRowsFromHistory({
      promptId, outputs: entry.outputs, apiPrompt,
      createdAt: Date.now(), statusMessages: entry.status?.messages,
      triggeredBy: meta?.triggeredBy, conversationId: meta?.conversationId,
      messageId: meta?.messageId, modelFingerprint: meta?.modelFingerprint,
      templateHash: meta?.templateHash,
    });
    let inserted = 0;
    for (const row of rows) { if (repo.appendFromHistory(row)) inserted += 1; }
    if (inserted > 0) { emitGalleryUpdate(); deleteSnapshot(promptId); clearPromptMeta(promptId); }
    return inserted;
  } catch (err) {
    logger.warn('gallery appendHistoryEntry failed', { promptId, message: err instanceof Error ? err.message : String(err) });
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

/** Explicit "Import from ComfyUI history" path. Returns `{ imported, skipped }`. */
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
          statusMessages: entry.status?.messages,
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

export async function list(): Promise<GalleryListItem[]> { return repo.listAll({ sort: 'newest' }); }
export function listByPromptIds(promptIds: readonly string[]): GalleryListItem[] { return repo.listByPromptIds(promptIds); }
export async function listPaginated(filter: ListFilter, page: number, pageSize: number): Promise<{ items: GalleryListItem[]; total: number }> {
  return repo.listPaginated({ mediaType: filter.mediaType, sort: filter.sort === 'oldest' ? 'oldest' : 'newest' }, page, pageSize);
}
export function remove(id: string): boolean { return repo.remove(id); }
export function getById(id: string): GalleryItem | null { return repo.getById(id); }
export function getByIdFull(id: string): GalleryItem | null { return repo.getByIdFull(id); }

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

/** Remove item: delete sqlite row + file on disk. Broadcasts on change. */
export function removeItem(id: string): RemoveItemResult {
  const result = removeItemInternal(id);
  if (result.removed) {
    emitGalleryUpdate();
    if (result.promptId) void deleteHistoryPrompts([result.promptId]);
  }
  return result;
}

/** Bulk delete — single broadcast after all ids processed. */
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
