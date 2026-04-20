// Per-scope expansion: the three-pass algorithm that expands wrapper
// instances, emits rewritten links, and emits real nodes into the flat
// state. Called recursively from `wrappers.expandWrapper`.

import { resolveOrigin } from './links.js';
import type {
  FlatNodeInput,
  FlattenState,
  InputSubs,
  OutputSubs,
  RawLink,
} from './types.js';
import { expandWrapper } from './wrappers.js';

// Emit scope links with rewritten endpoints. `-20` target_id means
// "external output of this scope" — feed each outer consumer instead.
// Links targeting a wrapper are dropped here (the wrapper's own
// expansion already wires those through via innerInputSubs).
export function emitScopeLinks(
  state: FlattenState,
  scopeLinks: RawLink[],
  scopeNodes: Array<Record<string, unknown>>,
  toGlobal: (id: number) => string,
  linkIdMap: Map<number, number>,
  inputSubs: InputSubs,
  outputSubs: OutputSubs,
): void {
  for (const link of scopeLinks) {
    const gid = linkIdMap.get(link.id)!;
    const origin = resolveOrigin(state, link.origin_id, link.origin_slot, toGlobal, inputSubs, scopeNodes);
    if (!origin) continue;

    if (link.target_id === -20) {
      const subs = outputSubs.get(link.target_slot) || [];
      for (const sub of subs) {
        state.links.push({
          id: state.nextLinkId++,
          origin_id: origin.nodeId,
          origin_slot: origin.slot,
          target_id: String(sub.nodeId),
          target_slot: sub.slot,
        });
      }
      continue;
    }

    const targetNode = scopeNodes.find(n => (n.id as number) === link.target_id);
    if (targetNode && state.sgMap.has(targetNode.type as string)) continue;

    state.links.push({
      id: gid,
      origin_id: origin.nodeId,
      origin_slot: origin.slot,
      target_id: toGlobal(link.target_id),
      target_slot: link.target_slot,
    });
  }
}

// Emit real nodes (skip wrappers — they were expanded already, skip
// Note / MarkdownNote markers, skip muted mode-2 nodes). Rewrites each
// input's link id from local -> global.
export function emitScopeNodes(
  state: FlattenState,
  scopeNodes: Array<Record<string, unknown>>,
  toGlobal: (id: number) => string,
  linkIdMap: Map<number, number>,
  proxyOverrides: Map<string, Record<string, unknown>>,
): void {
  for (const node of scopeNodes) {
    const type = node.type as string;
    if (!type || type === 'MarkdownNote' || type === 'Note') continue;
    const localId = node.id as number;
    if (localId < 0) continue;
    if (state.sgMap.has(type)) continue;
    if ((node.mode as number | undefined) === 2) continue;

    const gid = toGlobal(localId);
    const rawInputs = (node.inputs || []) as FlatNodeInput[];
    const inputs: FlatNodeInput[] = rawInputs.map(inp => {
      if (inp.link == null) return inp;
      const mapped = linkIdMap.get(inp.link);
      return mapped != null ? { ...inp, link: mapped } : { ...inp, link: null };
    });

    state.nodes.set(gid, {
      id: gid,
      type,
      inputs,
      widgets_values: (node.widgets_values || []) as unknown[],
      title: node.title as string | undefined,
      mode: node.mode as number | undefined,
      overrides: proxyOverrides.get(gid),
    });
  }
}

/**
 * Expand a single scope into the global flat graph. Three passes:
 *   1. Expand every wrapper node (populates state.wrapperOutputs).
 *   2. Emit rewritten links for this scope.
 *   3. Emit real nodes for this scope.
 */
export function expandScope(
  state: FlattenState,
  prefix: string,
  scopeNodes: Array<Record<string, unknown>>,
  scopeLinks: RawLink[],
  inputSubs: InputSubs,
  outputSubs: OutputSubs,
  proxyOverrides: Map<string, Record<string, unknown>>,
): void {
  const toGlobal = (localId: number): string => prefix ? `${prefix}:${localId}` : String(localId);

  const linkIdMap = new Map<number, number>();
  for (const l of scopeLinks) linkIdMap.set(l.id, state.nextLinkId++);

  // Pass 1 — expand wrappers.
  for (const node of scopeNodes) {
    const type = node.type as string;
    if (!type || type === 'MarkdownNote' || type === 'Note') continue;
    const localId = node.id as number;
    if (localId < 0) continue;
    const sg = state.sgMap.get(type);
    if (!sg) continue;
    expandWrapper(
      state, node, sg, prefix, scopeNodes, scopeLinks,
      inputSubs, outputSubs, toGlobal(localId), expandScope,
    );
  }

  // Pass 2 — emit links.
  emitScopeLinks(state, scopeLinks, scopeNodes, toGlobal, linkIdMap, inputSubs, outputSubs);

  // Pass 3 — emit nodes.
  emitScopeNodes(state, scopeNodes, toGlobal, linkIdMap, proxyOverrides);
}
