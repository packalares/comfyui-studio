// Workflow metadata extraction for imported user workflows.
//
// Given a LiteGraph document we derive:
//   - `io.inputs`  — user-facing loader nodes (LoadImage / LoadVideo / LoadAudio)
//   - `io.outputs` — save nodes (SaveImage / SaveVideo / SaveAudio / PreviewImage)
//   - `mediaType`  — "image" / "video" / "audio" derived from the dominant
//                    output node type; falls back to "image".
//   - `studioCategory` — mirrors `mapCategory` in templates.service.ts so
//                    import-staged templates sort into the same sidebar bucket
//                    as upstream ones with the same mediaType.
//
// Pure: no I/O. Used by the staging commit path so user imports carry the
// same non-wire metadata (and therefore the same form inputs) as upstream.

import { flattenWorkflow } from '../workflow/flatten/index.js';

export interface WorkflowIo {
  inputs: Array<{ nodeId: string; nodeType: string; file?: string; mediaType: string }>;
  outputs: Array<{ nodeId: string; nodeType: string; file: string; mediaType: string }>;
}

export type MediaType = 'image' | 'video' | 'audio';
export type StudioCategory = 'image' | 'video' | 'audio' | '3d' | 'tools';

// Node-type prefixes / classes treated as save nodes. We keep the list
// prefix-matched so vendored ports (e.g. `VHS_VideoCombine`) are picked up
// without maintaining a hard-coded union. Input classification lives in
// `classifyInput` below since it has more edge cases.
const OUTPUT_TYPES: Array<{ match: (t: string) => boolean; mediaType: MediaType }> = [
  { match: (t) => /^SaveImage$/i.test(t) || /^PreviewImage$/i.test(t), mediaType: 'image' },
  { match: (t) => /SaveVideo/i.test(t) || /VHS_VideoCombine/i.test(t), mediaType: 'video' },
  { match: (t) => /SaveAudio/i.test(t), mediaType: 'audio' },
];

function firstWidgetString(widgetsValues: unknown): string | undefined {
  if (!Array.isArray(widgetsValues)) return undefined;
  for (const v of widgetsValues) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function classifyInput(t: string): MediaType | null {
  if (/^LoadImage/i.test(t)) return 'image';
  if (/LoadVideo/i.test(t) || /VHS_LoadVideo/i.test(t)) return 'video';
  if (/LoadAudio/i.test(t) || /VHS_LoadAudio/i.test(t)) return 'audio';
  return null;
}

function classifyOutput(t: string): MediaType | null {
  for (const r of OUTPUT_TYPES) if (r.match(t)) return r.mediaType;
  return null;
}

/**
 * Walk every node in the workflow (including nested subgraphs) and classify
 * inputs/outputs. Uses the flattener so loaders/savers nested inside
 * subgraph instances surface with their flat compound id (e.g. `"424:269"`)
 * — top-level nodes still come out as their plain stringified id (`"269"`),
 * so old templates round-trip unchanged. `file` on inputs is the first
 * widget string (ComfyUI stores the selected upload filename there); on
 * outputs it's the filename prefix widget.
 */
export function extractWorkflowIo(workflow: unknown): WorkflowIo {
  const out: WorkflowIo = { inputs: [], outputs: [] };
  if (!workflow || typeof workflow !== 'object') return out;
  let flat;
  try {
    flat = flattenWorkflow(workflow as Record<string, unknown>);
  } catch {
    return out;
  }
  for (const [flatId, node] of flat.nodes) {
    const t = node.type || '';
    if (!t) continue;
    const inKind = classifyInput(t);
    if (inKind) {
      out.inputs.push({
        nodeId: flatId,
        nodeType: t,
        file: firstWidgetString(node.widgets_values),
        mediaType: inKind,
      });
      continue;
    }
    const outKind = classifyOutput(t);
    if (outKind) {
      out.outputs.push({
        nodeId: flatId,
        nodeType: t,
        file: firstWidgetString(node.widgets_values) ?? '',
        mediaType: outKind,
      });
    }
  }
  return out;
}

/**
 * Derive the dominant output media type. "Dominant" means: if there's any
 * Save/Preview node of a given type, that type wins. Video > Audio > Image
 * when multiple are present — most civitai packs with a Save* node are
 * single-media, so this tie-break is rarely exercised.
 */
export function deriveMediaType(io: WorkflowIo): MediaType {
  let hasImage = false;
  let hasAudio = false;
  let hasVideo = false;
  for (const o of io.outputs) {
    if (o.mediaType === 'video') hasVideo = true;
    else if (o.mediaType === 'audio') hasAudio = true;
    else if (o.mediaType === 'image') hasImage = true;
  }
  if (hasVideo) return 'video';
  if (hasAudio) return 'audio';
  if (hasImage) return 'image';
  return 'image';
}

/**
 * Same mapping as `mapCategory` in templates.service.ts — keeps staged
 * imports in the same sidebar bucket as upstream ones.
 */
export function mediaTypeToStudioCategory(mt: MediaType): StudioCategory {
  if (mt === 'video') return 'video';
  if (mt === 'audio') return 'audio';
  return 'image';
}
