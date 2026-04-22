// Gallery row builder.
//
// Turns a single ComfyUI history entry (prompt + outputs) into zero or
// more `GalleryRow` objects — one per output file. Split out of
// `gallery.service.ts` so the service itself stays under the src-file
// line cap; this module has no side effects (no sqlite, no broadcaster).

import { detectMediaType, collectNodeOutputFiles } from './comfyui.js';
import type * as repo from '../lib/db/gallery.repo.js';
import { extractMetadata, type ApiPrompt } from './gallery.extract.js';
import { workflowHash } from '../lib/workflowHash.js';

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
  /**
   * Raw workflow JSON (the UI-graph shape with subgraph definitions and
   * Primitive* nodes). Needed for title-based metadata extraction on
   * modern subgraph workflows. Optional — falls back to apiPrompt only.
   */
  workflowGraph?: unknown;
  /** ComfyUI history `status.messages` array — used for duration extraction. */
  statusMessages?: unknown[];
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
      });
      fileIndex += 1;
    }
  }
  return rows;
}
