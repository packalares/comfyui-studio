// Identify encoder nodes whose output flows into a sampler's `negative`
// conditioning input. The widget walker and proxy-promote collector both
// MUST skip these — the user's main-form prompt is the positive surface,
// and exposing a negative encoder's text widget produces a redundant form
// field that nobody wants to drive directly (it's a workflow constant).
//
// Title-based filtering (`/negative/i.test(node.title)`) catches the
// common explicit case but misses untitled encoders. Wire walking is
// authoritative — anything that feeds a `negative*`-named input slot on a
// downstream consumer is a negative encoder regardless of its own title.

import type { FlatLink, FlatNode } from '../../workflow/flatten/index.js';

/** True when `name` is a negative-conditioning slot name. Covers the
 *  common variants: bare `negative` plus prefixed forms used by some
 *  custom samplers (`negative_prompt`, `negative_cond`, ...). */
function isNegativeSlot(name: string | undefined): boolean {
  if (!name) return false;
  return name === 'negative' || name.startsWith('negative');
}

/**
 * Walk every link in the flattener's output. For each link whose target
 * input is a negative slot, record the origin node id. Returns a set of
 * compound ids to skip in candidate emission.
 */
export function collectNegativeOriginNodeIds(
  flatNodes: Map<string, FlatNode>,
  flatLinks: FlatLink[],
): Set<string> {
  const negatives = new Set<string>();
  for (const link of flatLinks) {
    const target = flatNodes.get(link.target_id);
    if (!target) continue;
    const inp = target.inputs?.[link.target_slot];
    if (!inp) continue;
    if (!isNegativeSlot(inp.name)) continue;
    negatives.add(link.origin_id);
  }
  return negatives;
}
