// Link normalisation + origin resolution. Kept separate from the scope /
// wrapper expansion so the algebra of "what is a link's real source" can
// be audited in isolation.

import type { FlattenState, InputSubs, RawLink } from './types.js';

/**
 * LiteGraph stores links in two shapes:
 *   - `[id, origin_id, origin_slot, target_id, target_slot, type]` at top level
 *   - plain objects with those fields inside subgraph definitions
 * Normalise both to the object shape so callers can treat them uniformly.
 */
export function normalizeLinks(raw: unknown[]): RawLink[] {
  const out: RawLink[] = [];
  for (const l of raw) {
    if (Array.isArray(l)) {
      out.push({
        id: l[0] as number,
        origin_id: l[1] as number,
        origin_slot: l[2] as number,
        target_id: l[3] as number,
        target_slot: l[4] as number,
      });
    } else if (l && typeof l === 'object') {
      const ll = l as Record<string, unknown>;
      out.push({
        id: ll.id as number,
        origin_id: ll.origin_id as number,
        origin_slot: ll.origin_slot as number,
        target_id: ll.target_id as number,
        target_slot: ll.target_slot as number,
      });
    }
  }
  return out;
}

/**
 * Resolve a link's origin into a real (nodeId, slot) pair.
 *  - origin_id === -10: external input pin of this scope; look it up in
 *    `inputSubs` (the parent scope's rewiring).
 *  - origin node is a wrapper: use `state.wrapperOutputs` (populated when
 *    the wrapper was expanded) to find the real internal source.
 *  - otherwise: prefix the local numeric id to produce the global id.
 */
export function resolveOrigin(
  state: FlattenState,
  originId: number,
  originSlot: number,
  toGlobal: (id: number) => string,
  inputSubs: InputSubs,
  scopeNodes: Array<Record<string, unknown>>,
): { nodeId: string; slot: number } | null {
  if (originId === -10) return inputSubs.get(originSlot) ?? null;
  const node = scopeNodes.find(n => (n.id as number) === originId);
  if (!node) return { nodeId: toGlobal(originId), slot: originSlot };
  const sg = state.sgMap.get(node.type as string);
  if (!sg) return { nodeId: toGlobal(originId), slot: originSlot };
  return state.wrapperOutputs.get(toGlobal(originId))?.get(originSlot) ?? null;
}
