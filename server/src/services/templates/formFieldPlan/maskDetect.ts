// Mask-kind detection for a LoadImage node in a flattened workflow.
//
// Determines whether an image upload field needs a brush-paint mask UI
// (inpainting) or a drag-edges pad UI (outpainting) by walking outgoing
// links from the node's output slots through the flat link graph.
//
// Why flat-graph walk instead of raw LiteGraph links? Subgraph proxy wires
// need to be resolved to their inner consumers, which the flattener already
// handles. Operating on the post-flatten representation avoids duplicating
// that traversal logic.

import type { FlatLink, FlatNode } from '../../workflow/flatten/index.js';

// Node types that consume the MASK output of a LoadImage node for inpainting.
const BRUSH_CONSUMER_TYPES = new Set([
  'InpaintModelConditioning',
  'SetLatentNoiseMask',
  'ControlNetInpaintingAliMamaApply',
  'ImageCompositeMasked',
]);

const PAD_PRODUCER_TYPE = 'ImagePadForOutpaint';

// LoadImage output slots: 0 = IMAGE, 1 = MASK
const IMAGE_SLOT = 0;
const MASK_SLOT = 1;

// Maximum recursion depth guard against cyclic or deeply nested subgraphs.
const MAX_DEPTH = 8;

export interface MaskDetection {
  kind: 'brush' | 'pad';
  /** Top-level subgraph wrapper id (the value mode-select options carry)
   *  when the consumer is inside a subgraph. Undefined when the consumer
   *  sits at top level — that detection then applies in every mode. */
  requiresMode?: string;
  /** Flat id of the ImagePadForOutpaint node when kind === 'pad'. */
  padTargetNodeId?: string;
}

/** Extract the top-level wrapper id from a flat compound id ("108:38" → "108").
 *  Compound ids are the flattener's convention for nodes inside subgraph
 *  instances. A bare id ("38") returns undefined — that node is top-level. */
function topWrapperId(flatId: string): string | undefined {
  const i = flatId.indexOf(':');
  return i > 0 ? flatId.slice(0, i) : undefined;
}

/**
 * Build a lookup: origin flat id + slot → list of target flat ids.
 * Precomputed once and shared across brush/pad searches.
 */
function buildLinkIndex(
  links: FlatLink[],
): Map<string, Array<{ targetId: string; targetSlot: number }>> {
  const idx = new Map<string, Array<{ targetId: string; targetSlot: number }>>();
  for (const link of links) {
    const key = `${link.origin_id}:${link.origin_slot}`;
    const entry = idx.get(key) ?? [];
    entry.push({ targetId: link.target_id, targetSlot: link.target_slot });
    idx.set(key, entry);
  }
  return idx;
}

/**
 * Walk the link graph starting from `startId:startSlot`, calling `visitor`
 * for each reachable (node, incomingSlot) pair. Returns early when the
 * visitor returns true (match found).
 *
 * Continues through intermediate nodes: if a reachable node is a known
 * pass-through (e.g. an ImagePreview or debug-only node), we can skip it.
 * In practice, brush consumers are direct or one-hop from LoadImage so the
 * extra pass-through logic is not needed — we simply visit every reachable
 * node within the depth budget.
 */
function walkLinksFrom(
  flatNodes: Map<string, FlatNode>,
  linkIndex: Map<string, Array<{ targetId: string; targetSlot: number }>>,
  startId: string,
  startSlot: number,
  visitor: (node: FlatNode, incomingSlot: number) => boolean,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const key = `${startId}:${startSlot}`;
  const targets = linkIndex.get(key);
  if (!targets) return false;
  for (const { targetId, targetSlot } of targets) {
    const targetNode = flatNodes.get(targetId);
    if (!targetNode) continue;
    if (visitor(targetNode, targetSlot)) return true;
    // Recurse into the target's output slots to follow deeper chains.
    // We check all output slots so we don't need to know the node's schema.
    const outputCount = 4; // generous upper bound for any node
    for (let slot = 0; slot < outputCount; slot++) {
      if (walkLinksFrom(flatNodes, linkIndex, targetId, slot, visitor, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Given a flattened workflow and a LoadImage node's flat id, decide what
 * mask UI (if any) the field needs.
 *
 * Returns ALL applicable detections, deduped by (kind, requiresMode). A
 * template with two pipelines (e.g. OneReward inpaint + outpaint) yields
 * two entries — `{kind: 'brush', requiresMode: '108'}` and
 * `{kind: 'pad', requiresMode: '110'}` — so the UI can swap the modal
 * based on the active mode-select value. A simple template yields a single
 * entry with `requiresMode: undefined`.
 *
 * Empty array means the LoadImage's outputs go nowhere mask-relevant.
 */
export function detectMaskKindsForLoadImage(
  flatNodes: Map<string, FlatNode>,
  links: FlatLink[],
  loadImageFlatId: string,
): MaskDetection[] {
  const linkIndex = buildLinkIndex(links);
  const out: MaskDetection[] = [];
  const seen = new Set<string>();
  const add = (entry: MaskDetection): void => {
    const key = `${entry.kind}|${entry.requiresMode ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  // MASK slot (slot 1) → inpainting consumers
  walkLinksFrom(flatNodes, linkIndex, loadImageFlatId, MASK_SLOT, (node) => {
    if (BRUSH_CONSUMER_TYPES.has(node.type)) {
      add({ kind: 'brush', requiresMode: topWrapperId(node.id) });
    }
    return false; // keep walking — a template can have brush consumers in
                  // multiple subgraphs that we want to surface separately.
  });

  // IMAGE slot (slot 0) → ImagePadForOutpaint
  walkLinksFrom(flatNodes, linkIndex, loadImageFlatId, IMAGE_SLOT, (node) => {
    if (node.type === PAD_PRODUCER_TYPE) {
      add({ kind: 'pad', requiresMode: topWrapperId(node.id), padTargetNodeId: node.id });
    }
    return false;
  });

  return out;
}
