// Media-upload candidates from `template.io.inputs`.
//
// Identical to the legacy `mediaInput` factory in templates.formInputs.ts —
// kept as its own collector so the formFieldPlan pipeline has one entry per
// source. Runs first so media `nodeId` references can match against any
// widget-walk fields the user might've authored on the same node.
//
// Note: media uploads carry their own `nodeId` (top-level numeric id) because
// `applyFormInputs` writes the upload with `prompt[String(nodeId)].inputs.image`.
// They do NOT use the `bindNodeId` / `bindWidgetName` pair — that's reserved
// for prompt-surface widget routing via `applyBoundFormInputs`. Downstream
// dedup is by `id` only for media fields.

import type { FormFieldCandidate } from './types.js';
import type { RawTemplate } from '../types.js';
import type { FlatLink, FlatNode } from '../../workflow/flatten/index.js';
import { detectMaskKindsForLoadImage, type MaskDetection } from './maskDetect.js';

function cleanFileName(file: string): string {
  return file
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Walk the workflow's links for any link whose origin is `loaderNodeId`.
 * Return true when at least one downstream input it feeds has `shape === 7`
 * (LiteGraph's "optional input" marker). When the loader feeds an optional
 * socket, the upload field is non-required — the user can leave it blank
 * and the prompt-emit step deletes the loader node.
 */
function loaderFeedsOptionalInput(
  workflow: Record<string, unknown> | undefined,
  loaderNodeId: number,
): boolean | null {
  if (!workflow) return null;
  const links = (workflow.links as unknown[] | undefined) ?? [];
  const nodes = (workflow.nodes as Array<Record<string, unknown>> | undefined) ?? [];
  for (const raw of links) {
    if (!Array.isArray(raw) || raw.length < 5) continue;
    if (raw[1] !== loaderNodeId) continue;
    const targetNodeId = raw[3] as number;
    const targetSlot = raw[4] as number;
    const target = nodes.find((n) => (n.id as number) === targetNodeId);
    const targetInputs = (target?.inputs as Array<Record<string, unknown>> | undefined) ?? [];
    const inp = targetInputs[targetSlot];
    if (inp && inp.shape === 7) return true;
  }
  return false;
}

interface FlatData {
  nodes: Map<string, FlatNode>;
  links: FlatLink[];
}

function mediaCandidate(
  mediaType: 'image' | 'audio' | 'video',
  index: number,
  input: { nodeId: number; nodeType: string; file?: string; mediaType: string },
  workflow?: Record<string, unknown>,
  flatData?: FlatData,
): FormFieldCandidate {
  const defaultLabel = `${mediaType.charAt(0).toUpperCase()}${mediaType.slice(1)} ${index + 1}`;
  const isOptional = loaderFeedsOptionalInput(workflow, input.nodeId) === true;

  // For LoadImage nodes, detect every mask/pad path the downstream graph
  // exposes. A template with two pipelines (e.g. OneReward inpaint +
  // outpaint) emits two entries — each tagged with the subgraph it requires
  // — so the UI can swap the modal between brush and pad based on the
  // active mode-select value.
  let maskable: MaskDetection[] | undefined;
  // Server-side submit uses the first pad detection's target id. ComfyUI
  // bypasses inactive subgraphs, so writing pad widgets onto a bypassed
  // ImagePadForOutpaint is a no-op — making "use the first one" safe even
  // when multiple pad paths exist.
  let padTargetNodeId: string | undefined;
  if (mediaType === 'image' && input.nodeType === 'LoadImage' && flatData) {
    const flatId = String(input.nodeId);
    const detections = detectMaskKindsForLoadImage(flatData.nodes, flatData.links, flatId);
    if (detections.length > 0) {
      maskable = detections;
      padTargetNodeId = detections.find(d => d.kind === 'pad')?.padTargetNodeId;
    }
  }

  return {
    id: `${mediaType}_${index}`,
    label: input.file ? cleanFileName(input.file) : defaultLabel,
    type: mediaType,
    required: !isOptional,
    nodeId: input.nodeId,
    nodeType: input.nodeType,
    mediaType,
    source: 'media-upload',
    ...(maskable !== undefined && { maskable }),
    ...(padTargetNodeId !== undefined && { padTargetNodeId }),
  };
}

/**
 * Build media-upload candidates from `template.io.inputs`. Order matches the
 * iteration order so the UI renders uploads in the same sequence the workflow
 * declared them.
 *
 * `flatData` is optional: when present, image fields for LoadImage nodes are
 * annotated with a `maskable` flag derived from the downstream graph.
 */
export function collectMediaFields(
  template: RawTemplate,
  workflow?: Record<string, unknown>,
  flatData?: FlatData,
): FormFieldCandidate[] {
  const out: FormFieldCandidate[] = [];
  const ioInputs = template.io?.inputs ?? [];
  for (let i = 0; i < ioInputs.length; i++) {
    const input = ioInputs[i];
    if (input.mediaType === 'image') out.push(mediaCandidate('image', i, input, workflow, flatData));
    else if (input.mediaType === 'audio') out.push(mediaCandidate('audio', i, input, workflow));
    else if (input.mediaType === 'video') out.push(mediaCandidate('video', i, input, workflow));
  }
  return out;
}
