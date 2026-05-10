// Gallery service — glues the sqlite repo to ComfyUI history events.

import fs from 'fs';
import { getGalleryItems, getHistoryForPrompt, deleteHistoryPrompts, detectMediaType, collectNodeOutputFiles } from '../comfyui/api.js';
import type { GalleryItem, GalleryListItem } from '../../contracts/generation.contract.js';
import * as repo from '../../lib/db/gallery.repo.js';
import { logger } from '../../lib/logger.js';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../../lib/fs.js';
import { extractMetadata, type ApiPrompt } from './extract.js';
import { workflowHash } from '../../lib/workflowHash.js';
import { getPromptMeta, clearPromptMeta } from './promptMeta.js';
import { getSnapshot, deleteSnapshot } from '../../lib/db/promptSnapshots.repo.js';

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

// ─── Row builder (pure: history entry → GalleryRow[]) ────────────────────────

/**
 * Extract the inner API-format workflow dict from a ComfyUI history entry.
 * ComfyUI stores it as a 5-tuple `[num, prompt_id, prompt_dict, extra_data,
 * outputs_to_execute]`, but older builds / forks sometimes return the
 * dict directly. Returns null when neither shape matches.
 */
export function normalisePromptField(raw: unknown): ApiPrompt | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    // Canonical: [num, promptId, prompt, extra_data, outputs_to_execute]
    const dict = raw[2];
    if (dict && typeof dict === 'object') return dict as ApiPrompt;
    // Some forks place the prompt at [0] or [1]; walk the tuple for the
    // first object-valued element as a fallback.
    for (const el of raw) {
      if (el && typeof el === 'object' && !Array.isArray(el)) return el as ApiPrompt;
    }
    return null;
  }
  if (typeof raw === 'object') return raw as ApiPrompt;
  return null;
}

export interface RowBuildInput {
  promptId: string;
  outputs: Record<string, Record<string, unknown>>;
  apiPrompt: ApiPrompt | null;
  createdAt: number;
  templateName?: string | null;
  /** Raw workflow JSON for title-based metadata extraction. Falls back to apiPrompt only. */
  workflowGraph?: unknown;
  /** ComfyUI history `status.messages` array — used for duration extraction. */
  statusMessages?: unknown[];
  /** Provenance: how the generation was triggered. */
  triggeredBy?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  /** Fingerprints computed at submit time. */
  modelFingerprint?: string | null;
  templateHash?: string | null;
}

/**
 * Build one or more rows from a single history entry. Each output file
 * becomes its own row (keyed `<promptId>-<filename>`); every row shares
 * the same extracted metadata + workflowJson since they all came from
 * the same execution.
 */
export function buildRowsFromHistory(input: RowBuildInput): repo.GalleryRow[] {
  const meta = extractMetadata(input.apiPrompt, input.workflowGraph, input.statusMessages);
  const workflowJson = input.apiPrompt ? JSON.stringify(input.apiPrompt) : null;
  const hash = input.apiPrompt ? workflowHash(input.apiPrompt) : null;
  const rows: repo.GalleryRow[] = [];
  let fileIndex = 0;
  for (const nodeOutput of Object.values(input.outputs || {})) {
    for (const f of collectNodeOutputFiles(nodeOutput)) {
      // Skip ComfyUI's temp-folder outputs — PreviewImage, MaskPreview,
      // PreviewBridge and similar debug nodes write there. They're ephemeral
      // (ComfyUI prunes `temp/` itself) and shouldn't occupy gallery rows.
      // `SaveImage` etc. use `type: 'output'`, so user-authored saves stay.
      if (f.type === 'temp') continue;
      const subfolder = f.subfolder || '';
      const type = f.type || 'output';
      rows.push({
        id: `${input.promptId}-${f.filename}`,
        filename: f.filename,
        subfolder,
        type,
        mediaType: detectMediaType(f.filename),
        url: `/api/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`,
        promptId: input.promptId,
        createdAt: input.createdAt - fileIndex,
        templateName: input.templateName ?? null,
        workflowJson,
        promptText: meta.promptText,
        negativeText: meta.negativeText,
        seed: meta.seed,
        model: meta.model,
        sampler: meta.sampler,
        steps: meta.steps,
        cfg: meta.cfg,
        width: meta.width,
        height: meta.height,
        workflowHash: hash,
        scheduler: meta.scheduler,
        denoise: meta.denoise,
        lengthFrames: meta.length,
        fps: meta.fps,
        batchSize: meta.batchSize,
        durationMs: meta.durationMs,
        models: meta.models,
        triggeredBy: input.triggeredBy ?? null,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        modelFingerprint: input.modelFingerprint ?? null,
        templateHash: input.templateHash ?? null,
      });
      fileIndex += 1;
    }
  }
  return rows;
}

// ─── Service operations ───────────────────────────────────────────────────────

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
    // Feed the event payload through the same row-builder the history path uses.
    // `outputs` is keyed by node id in history, but for single-node events we
    // just need one synthetic bucket; the row id still combines promptId +
    // filename so dedup across `executed` bursts works.
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

  const outputRoot = paths.comfyOutputDir;
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
        logger.info('gallery removeItem: file already absent', { id, path: target });
      }
    } catch (err) {
      fileError = err instanceof Error ? err.message : String(err);
      logger.warn('gallery removeItem: file delete failed', { id, error: fileError });
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
