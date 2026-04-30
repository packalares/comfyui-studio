// Link resolution — follows a link through any pass-through / UI-only node
// (Reroute, PrimitiveNode, GetNode/SetNode, bypassed nodes) to find either
// the real upstream (nodeId, slot) or a literal value.
//
// Two public entry points:
//   - `buildSetterMap(ctx)`: pre-computes SetNode variable bindings so
//     GetNode lookups run in O(1) during resolution.
//   - `resolveInput(linkId, ctx)`: the actual follow-the-chain walker.

import type { FlatLink, FlatNode } from './flatten/index.js';

export type InputResolution =
  | { kind: 'ref'; nodeId: string; slot: number }
  | { kind: 'literal'; value: unknown };

export interface ResolveCtx {
  linkMap: Map<number, FlatLink>;
  nodes: Map<string, FlatNode>;
  objectInfo: Record<string, Record<string, unknown>>;
  /** Maps SetNode variable name -> resolved source (pre-computed). */
  setterMap: Map<string, InputResolution>;
}

// Legacy pre-subgraph widget promoters — inline their value as a literal
// into downstream consumers. Typed Primitive* classes (PrimitiveInt,
// PrimitiveStringMultiline, etc.) are real nodes in modern ComfyUI; we DO
// NOT inline them, we keep wire references so they emit normally.
const PRIMITIVE_HOLDER_TYPES = new Set<string>([
  'PrimitiveNode',
]);

// Reroute pass-through: follow the first input link.
function followReroute(origin: FlatNode): number | null {
  return origin.inputs?.[0]?.link ?? null;
}

// Get/Set variable binding lookup.
function followGetNode(
  origin: FlatNode,
  setterMap: Map<string, InputResolution>,
): InputResolution | null {
  const varName = origin.widgets_values?.[0] as string | undefined;
  if (!varName) return null;
  return setterMap.get(varName) ?? null;
}

// Bypassed (mode 4) node: reroute to an input whose type matches the
// requested output slot; fall back to the first connected input.
function followBypassed(
  origin: FlatNode,
  outputSlot: number,
  objectInfo: Record<string, Record<string, unknown>>,
): number | null {
  const info = objectInfo[origin.type] as {
    input?: {
      required?: Record<string, unknown[]>;
      optional?: Record<string, unknown[]>;
    };
    output?: string[];
  } | undefined;
  const targetType = info?.output?.[outputSlot];
  const allInputs = { ...(info?.input?.required || {}), ...(info?.input?.optional || {}) };
  if (targetType) {
    for (const inp of origin.inputs || []) {
      if (inp.link == null) continue;
      const spec = allInputs[inp.name] as unknown[] | undefined;
      if (spec?.[0] === targetType) return inp.link;
    }
  }
  // Fall back to the first connected input.
  const fb = (origin.inputs || []).find(i => i.link != null);
  return fb?.link ?? null;
}

/**
 * Follow a link through any non-executable / pass-through node to find
 * either a literal value or the real upstream `(nodeId, slot)` ComfyUI
 * should see. Handles Reroute, Primitive* holders, Get/Set pairs, and
 * bypassed (mode 4) nodes. Muted (mode 2) nodes are already absent from
 * `ctx.nodes` — we return null if we stumble into one.
 */
export function resolveInput(linkId: number, ctx: ResolveCtx): InputResolution | null {
  const visited = new Set<number>();
  let currentId = linkId;
  while (true) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const link = ctx.linkMap.get(currentId);
    if (!link) return null;
    const origin = ctx.nodes.get(link.origin_id);
    if (!origin) return { kind: 'ref', nodeId: link.origin_id, slot: link.origin_slot };
    if (origin.mode === 2) return null;

    if (origin.type === 'Reroute') {
      const next = followReroute(origin);
      if (next == null) return null;
      currentId = next;
      continue;
    }

    if (PRIMITIVE_HOLDER_TYPES.has(origin.type)) {
      return { kind: 'literal', value: origin.widgets_values?.[0] };
    }

    if (origin.type === 'GetNode' || origin.type === 'easy getNode') {
      return followGetNode(origin, ctx.setterMap);
    }

    if (origin.mode === 4) {
      const next = followBypassed(origin, link.origin_slot, ctx.objectInfo);
      if (next == null) return null;
      currentId = next;
      continue;
    }

    return { kind: 'ref', nodeId: link.origin_id, slot: link.origin_slot };
  }
}

/** Pre-compute SetNode variable bindings so GetNode lookups are O(1).
 *
 * Iterates to a fixed point so that multi-hop named-variable chains
 * (`SetA <- GetB <- SetB <- GetC <- SetC <- realNode`) resolve correctly.
 * The earlier single-pass version passed an empty setterMap to avoid
 * circular deps, which collapsed any chain whose first hop was another
 * GetNode. That broke rgthree workflows where most data flow runs through
 * named variables (e.g. LTX 2.3 action-transfer-dual-control: only the
 * SigmasPreview branch ran because it was the lone single-hop chain).
 *
 * Termination: each pass either resolves at least one new var or stops.
 * Hard cap of `setters.size + 5` iterations as belt-and-suspenders against
 * any logic bug. Real cycles converge to null entries on the first pass and
 * stay null — same outcome as before, just reached more cleanly.
 */
export function buildSetterMap(
  ctx: Omit<ResolveCtx, 'setterMap'>,
): Map<string, InputResolution> {
  const setters: Array<{ varName: string; node: FlatNode }> = [];
  for (const node of ctx.nodes.values()) {
    if (node.type !== 'SetNode' && node.type !== 'easy setNode') continue;
    const varName = node.widgets_values?.[0] as string | undefined;
    if (varName) setters.push({ varName, node });
  }
  const setterMap = new Map<string, InputResolution>();
  let changed = true;
  let iterations = 0;
  const maxIterations = setters.length + 5;
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    for (const { varName, node } of setters) {
      if (setterMap.has(varName)) continue;
      const firstInput = node.inputs?.find(i => i.link != null);
      if (!firstInput?.link) continue;
      // Pass the *partial* setterMap so chains through already-resolved
      // GetNodes succeed; chains through still-unresolved vars return null
      // and get retried on the next pass.
      const resolved = resolveInput(firstInput.link, { ...ctx, setterMap });
      if (resolved) {
        setterMap.set(varName, resolved);
        changed = true;
      }
    }
  }
  return setterMap;
}
