// Fill in unbound subgraph input slots with synthetic literal nodes so
// every inner link from origin_id=-10 resolves to a known default value.
//
// When a subgraph input is promoted-but-unbound (no outer link on the
// wrapper instance), buildInnerInputSubs leaves that slot out of inputSubs.
// Any inner links from -10 at that slot are then silently dropped, leaving
// downstream non-widget targets (e.g. PreviewAny.source, StringReplace.replace)
// with empty inputs that ComfyUI rejects.
//
// This module injects a synthetic PrimitiveNode for each such slot, using
// the same value the proxyWidgets mechanism already resolved for the widget-
// backed target. PrimitiveNode is in UI_ONLY_TYPES and is inlined as a
// literal by resolveInput; it never appears in the final API prompt.

import { normalizeLinks } from './links.js';
import type { FlatNode, FlattenState, InputSubs } from './types.js';

// Map `-10` origin slot -> the first inner target (nodeId, inputName).
// Same helper used by buildProxyOverrides in wrappers.ts; duplicated here
// to keep the two files decoupled.
function slotToFirstTarget(
  sgNodes: Array<Record<string, unknown>>,
  sgLinks: ReturnType<typeof normalizeLinks>,
): Map<number, { nodeId: number; inputName: string }> {
  const out = new Map<number, { nodeId: number; inputName: string }>();
  for (const l of sgLinks) {
    if (l.origin_id !== -10) continue;
    if (out.has(l.origin_slot)) continue; // keep first hit per slot
    const tNode = sgNodes.find(n => (n.id as number) === l.target_id);
    const tInputs = (tNode?.inputs || []) as Array<Record<string, unknown>>;
    const tInput = tInputs.find(inp => (inp as Record<string, unknown>).link === l.id);
    const inputName =
      ((tInput?.widget as Record<string, unknown> | undefined)?.name as string)
      || (tInput?.name as string)
      || '';
    out.set(l.origin_slot, { nodeId: l.target_id, inputName });
  }
  return out;
}

/**
 * For each subgraph input slot not yet in `innerInputSubs`, look up the
 * slot's default value from the wrapper's proxyWidgets + widgets_values and
 * inject a synthetic PrimitiveNode literal holder. The inputSubs entry for
 * that slot then points at the synthetic node so resolveInput returns the
 * literal value for all inner links from that -10 origin slot.
 */
export function fillUnboundSlotLiterals(
  state: FlattenState,
  wrapper: Record<string, unknown>,
  sg: Record<string, unknown>,
  innerPrefix: string,
  innerInputSubs: InputSubs,
): void {
  const sgInputDefs = (sg.inputs || []) as Array<Record<string, unknown>>;
  if (sgInputDefs.length === 0) return;

  const sgNodes = (sg.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = normalizeLinks((sg.links || []) as unknown[]);
  const proxyWidgets = (
    (wrapper.properties as Record<string, unknown> | undefined)?.proxyWidgets || []
  ) as string[][];
  const wrapperWidgetVals = (wrapper.widgets_values || []) as unknown[];
  const slotToTarget = slotToFirstTarget(sgNodes, sgLinks);

  for (let slot = 0; slot < sgInputDefs.length; slot++) {
    if (innerInputSubs.has(slot)) continue;
    const target = slotToTarget.get(slot);
    if (!target) continue;
    const proxyIdx = proxyWidgets.findIndex(
      ([nodeIdStr, name]) =>
        nodeIdStr !== '-1'
        && Number(nodeIdStr) === target.nodeId
        && name === target.inputName,
    );
    const value = proxyIdx >= 0 ? wrapperWidgetVals[proxyIdx] : undefined;
    if (value === null || value === undefined) continue;

    const syntheticId = `${innerPrefix}:__lit_${slot}`;
    const syntheticNode: FlatNode = {
      id: syntheticId,
      type: 'PrimitiveNode',
      inputs: [],
      widgets_values: [value],
    };
    state.nodes.set(syntheticId, syntheticNode);
    innerInputSubs.set(slot, { nodeId: syntheticId, slot: 0 });
  }
}
