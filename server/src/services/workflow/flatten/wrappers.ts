// Wrapper (subgraph-instance) expansion. A wrapper has its own inputSubs
// (where does each pin source from, outside?), outputSubs (who consumes
// each pin, outside?), and per-inner-node proxy overrides (widgets_values
// on the wrapper carried into inner node inputs). After recursing we
// record wrapperOutputs so the parent scope can rewrite links whose
// origin was the wrapper itself.

import { normalizeLinks, resolveOrigin } from './links.js';
import type {
  FlattenState,
  InputSubs,
  OutputSubs,
  RawLink,
} from './types.js';

// Injected recursion target. Callers pass `expandScope` from scope.ts at the
// outer entry point; this keeps wrappers.ts free of an import cycle while the
// three-pass algorithm still recurses wrapper -> scope -> wrapper.
export type ExpandScopeFn = (
  state: FlattenState,
  prefix: string,
  scopeNodes: Array<Record<string, unknown>>,
  scopeLinks: RawLink[],
  inputSubs: InputSubs,
  outputSubs: OutputSubs,
  proxyOverrides: Map<string, Record<string, unknown>>,
) => void;

// Build this wrapper's inputSubs: for each wrapper input pin, resolve the
// real outer source. Key by subgraph-definition input INDEX (matched by
// name) — ComfyUI can reorder a wrapper's outer pins independently of the
// subgraph definition.
function buildInnerInputSubs(
  state: FlattenState,
  wrapper: Record<string, unknown>,
  sg: Record<string, unknown>,
  outerToGlobal: (id: number) => string,
  outerNodes: Array<Record<string, unknown>>,
  outerLinks: RawLink[],
  outerInputSubs: InputSubs,
): InputSubs {
  const sgInputDefs = (sg.inputs || []) as Array<Record<string, unknown>>;
  const innerInputSubs: InputSubs = new Map();
  const wrapperInputs = (wrapper.inputs || []) as Array<Record<string, unknown>>;
  for (let i = 0; i < wrapperInputs.length; i++) {
    const outerInput = wrapperInputs[i];
    const linkId = outerInput.link as number | null | undefined;
    if (linkId == null) continue;
    const link = outerLinks.find(l => l.id === linkId);
    if (!link) continue;
    const outerName = outerInput.name as string | undefined;
    const sgIdx = outerName != null
      ? sgInputDefs.findIndex(sgInp => (sgInp.name as string) === outerName)
      : -1;
    const key = sgIdx >= 0 ? sgIdx : i;
    const origin = resolveOrigin(state, link.origin_id, link.origin_slot, outerToGlobal, outerInputSubs, outerNodes);
    if (origin) innerInputSubs.set(key, origin);
  }
  return innerInputSubs;
}

// Build outputSubs for a wrapper: for each output pin, resolve outer
// consumers (chase -20 pins out through the parent scope's outputSubs).
function buildInnerOutputSubs(
  wrapper: Record<string, unknown>,
  outerLinks: RawLink[],
  outerOutputSubs: OutputSubs,
  outerToGlobal: (id: number) => string,
): Map<number, Array<{ nodeId: string; slot: number }>> {
  const innerOutputSubs = new Map<number, Array<{ nodeId: string; slot: number }>>();
  const wrapperOuts = (wrapper.outputs || []) as Array<{ links?: number[] }>;
  for (let i = 0; i < wrapperOuts.length; i++) {
    const outLinkIds = wrapperOuts[i].links || [];
    const targets: Array<{ nodeId: string; slot: number }> = [];
    for (const tlId of outLinkIds) {
      const tl = outerLinks.find(l => l.id === tlId);
      if (!tl) continue;
      if (tl.target_id === -20) {
        const parents = outerOutputSubs.get(tl.target_slot) || [];
        for (const p of parents) {
          targets.push({
            nodeId: typeof p.nodeId === 'string' ? p.nodeId : String(p.nodeId),
            slot: p.slot,
          });
        }
      } else {
        targets.push({ nodeId: outerToGlobal(tl.target_id), slot: tl.target_slot });
      }
    }
    innerOutputSubs.set(i, targets);
  }
  return innerOutputSubs;
}

// Map `-10` origin slot -> the (targetNodeId, inputName) it feeds, for a
// subgraph definition. Needed by buildProxyOverrides to resolve the
// innerNodeId='-1' sentinel in proxyWidgets.
function slotToTargetMap(
  sgNodes: Array<Record<string, unknown>>,
  sgLinks: RawLink[],
): Map<number, { nodeId: number; inputName: string }> {
  const slotToTarget = new Map<number, { nodeId: number; inputName: string }>();
  for (const l of sgLinks) {
    if (l.origin_id !== -10) continue;
    const targetNode = sgNodes.find(n => (n.id as number) === l.target_id);
    const tInputs = (targetNode?.inputs || []) as Array<Record<string, unknown>>;
    const tInput = tInputs.find(inp => (inp as Record<string, unknown>).link === l.id);
    const inputName =
      ((tInput?.widget as Record<string, unknown> | undefined)?.name as string)
      || (tInput?.name as string)
      || '';
    slotToTarget.set(l.origin_slot, { nodeId: l.target_id, inputName });
  }
  return slotToTarget;
}

// Build per-inner-node overrides from a wrapper's proxyWidgets so each
// inner node receives the wrapper's widgets_values at the correct input
// name.
function buildProxyOverrides(
  wrapper: Record<string, unknown>,
  sg: Record<string, unknown>,
  innerToGlobal: (id: number) => string,
): Map<string, Record<string, unknown>> {
  const proxyWidgets = (
    (wrapper.properties as Record<string, unknown> | undefined)?.proxyWidgets || []
  ) as string[][];
  const wrapperWidgetVals = (wrapper.widgets_values || []) as unknown[];
  const sgNodes = (sg.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = normalizeLinks((sg.links || []) as unknown[]);
  const sgInputDefs = (sg.inputs || []) as Array<Record<string, unknown>>;
  const slotToTarget = slotToTargetMap(sgNodes, sgLinks);

  const overrides = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < proxyWidgets.length && i < wrapperWidgetVals.length; i++) {
    const [innerNodeIdStr, widgetName] = proxyWidgets[i];
    const val = wrapperWidgetVals[i];
    if (val === null) continue;
    let targetLocalId: number;
    let targetName: string;
    if (innerNodeIdStr === '-1') {
      const sgIdx = sgInputDefs.findIndex(inp => (inp as Record<string, unknown>).name === widgetName);
      const target = slotToTarget.get(sgIdx >= 0 ? sgIdx : i);
      if (!target) continue;
      targetLocalId = target.nodeId;
      targetName = target.inputName;
    } else {
      targetLocalId = Number(innerNodeIdStr);
      targetName = widgetName;
    }
    const gid = innerToGlobal(targetLocalId);
    if (!overrides.has(gid)) overrides.set(gid, {});
    overrides.get(gid)![targetName] = val;
  }
  return overrides;
}

// Record where each output pin of this wrapper really sources from, so
// the outer scope's link emission can rewrite origin_id from the wrapper
// to the real inner node.
function recordWrapperOutputs(
  state: FlattenState,
  wrapperGlobalId: string,
  sg: Record<string, unknown>,
  innerToGlobal: (id: number) => string,
  innerInputSubs: InputSubs,
): void {
  const sgOutputs = (sg.outputs || []) as Array<Record<string, unknown>>;
  const sgNodes = (sg.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = normalizeLinks((sg.links || []) as unknown[]);
  const myOutputs = new Map<number, { nodeId: string; slot: number }>();
  for (let i = 0; i < sgOutputs.length; i++) {
    const linkIds = (sgOutputs[i].linkIds || []) as number[];
    if (linkIds.length === 0) continue;
    const link = sgLinks.find(l => l.id === linkIds[0]);
    if (!link) continue;
    const origin = resolveOrigin(state, link.origin_id, link.origin_slot, innerToGlobal, innerInputSubs, sgNodes);
    if (origin) myOutputs.set(i, origin);
  }
  state.wrapperOutputs.set(wrapperGlobalId, myOutputs);
}

/**
 * Expand a single wrapper instance into the flat graph: build inner
 * input / output subs + proxy overrides, recurse into the subgraph body,
 * then record this wrapper's outputs for the parent scope.
 */
export function expandWrapper(
  state: FlattenState,
  wrapper: Record<string, unknown>,
  sg: Record<string, unknown>,
  outerPrefix: string,
  outerNodes: Array<Record<string, unknown>>,
  outerLinks: RawLink[],
  outerInputSubs: InputSubs,
  outerOutputSubs: OutputSubs,
  wrapperGlobalId: string,
  expandScope: ExpandScopeFn,
): void {
  const outerToGlobal = (id: number): string => outerPrefix ? `${outerPrefix}:${id}` : String(id);
  const innerPrefix = wrapperGlobalId;
  const innerToGlobal = (id: number): string => `${innerPrefix}:${id}`;

  const innerInputSubs = buildInnerInputSubs(
    state, wrapper, sg, outerToGlobal, outerNodes, outerLinks, outerInputSubs,
  );
  const innerOutputSubs = buildInnerOutputSubs(wrapper, outerLinks, outerOutputSubs, outerToGlobal);
  const overrides = buildProxyOverrides(wrapper, sg, innerToGlobal);

  const sgNodes = (sg.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = normalizeLinks((sg.links || []) as unknown[]);
  expandScope(state, innerPrefix, sgNodes, sgLinks, innerInputSubs, innerOutputSubs, overrides);

  recordWrapperOutputs(state, wrapperGlobalId, sg, innerToGlobal, innerInputSubs);
}
