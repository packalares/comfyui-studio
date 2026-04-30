// Proxy-widget label resolution + advanced-setting extraction.
//
// ComfyUI templates expose widgets through wrapper nodes; the raw entry is
// `[innerNodeId, widgetName]` where the widget name is often generic ("value",
// "enabled") and the id alone is meaningless to users. `resolveProxyLabels`
// walks the subgraph's -10 wires to find the real target node + input and
// produces a pretty label for each proxy entry.
//
// `extractAdvancedSettings` turns the (label, value) pairs into the typed
// AdvancedSetting[] that the /workflow-settings endpoint returns.

import type { AdvancedSetting } from '../../contracts/workflow.contract.js';
import { BLAND_WIDGET_NAMES, titleCase } from './constants.js';
import {
  filteredWidgetValues,
  inferWidgetShape,
  widgetNamesFor,
} from './rawWidgets/shapes.js';

interface SlotTarget { nodeId: number; inputName: string }

// Locate the subgraph definition a wrapper node points at. The definition
// lives either inline on the node or in `workflow.definitions.subgraphs`.
export function findSubgraphDef(
  wrapperNode: Record<string, unknown>,
  workflow: Record<string, unknown>,
): Record<string, unknown> | null {
  const inline = wrapperNode.subgraph as Record<string, unknown> | undefined;
  if (inline) return inline;
  const rawSgs = (workflow.definitions as Record<string, unknown> | undefined)?.subgraphs;
  const wrapperType = wrapperNode.type as string;
  if (Array.isArray(rawSgs)) {
    return (rawSgs as Array<Record<string, unknown>>).find(s => s.id === wrapperType) ?? null;
  }
  if (rawSgs && typeof rawSgs === 'object') {
    return (rawSgs as Record<string, Record<string, unknown>>)[wrapperType] ?? null;
  }
  return null;
}

// Map subgraph input slot -> the internal (targetNodeId, inputName) it
// connects to, following -10 wires.
export function buildSlotTargetMap(
  sgNodes: Array<Record<string, unknown>>,
  sgLinks: Array<Record<string, unknown>>,
): Map<number, SlotTarget> {
  const slotTargets = new Map<number, SlotTarget>();
  for (const link of sgLinks) {
    if (link.origin_id !== -10) continue;
    const slot = link.origin_slot as number;
    const targetId = link.target_id as number;
    const targetNode = sgNodes.find(n => (n.id as number) === targetId);
    const targetInputs = (targetNode?.inputs || []) as Array<Record<string, unknown>>;
    const targetInput = targetInputs.find(
      inp => (inp as Record<string, unknown>).link === link.id,
    );
    const inputName =
      ((targetInput?.widget as Record<string, unknown> | undefined)?.name as string)
      || (targetInput?.name as string)
      || '';
    slotTargets.set(slot, { nodeId: targetId, inputName });
  }
  return slotTargets;
}

export interface ProxyLabelParts {
  /** Widget-side portion — rendered big by the UI ("Ckpt Name"). */
  label: string;
  /**
   * Node-side portion ("CheckpointLoaderSimple"). Absent when the widget
   * name was bland and collapsed into the primary label (`value`,
   * `enabled`, ...) — nothing useful would show in a tooltip.
   */
  scopeLabel?: string;
}

// Resolve a single proxy-widget entry into its widget/scope parts. Callers
// that still want the combined "Scope · Widget" string compose them.
function labelPartsFor(
  proxyEntry: string[],
  index: number,
  sgNodes: Array<Record<string, unknown>>,
  sgInputs: Array<Record<string, unknown>>,
  slotTargets: Map<number, SlotTarget>,
): ProxyLabelParts {
  const [innerNodeId, widgetName] = proxyEntry;
  let targetNode: Record<string, unknown> | undefined;
  let displayWidget = widgetName;

  if (innerNodeId === '-1') {
    const sgInput = sgInputs.find(inp => (inp as Record<string, unknown>).name === widgetName);
    const explicit =
      ((sgInput as Record<string, unknown> | undefined)?.label as string | undefined)
      ?? ((sgInput as Record<string, unknown> | undefined)?.localized_name as string | undefined);
    // An explicit author-provided subgraph input label is already the full
    // display string; nothing useful to put in the scope tooltip.
    if (explicit && explicit !== widgetName) return { label: titleCase(explicit) };

    const sgIdx = sgInputs.findIndex(inp => (inp as Record<string, unknown>).name === widgetName);
    const target = slotTargets.get(sgIdx >= 0 ? sgIdx : index);
    if (target) {
      targetNode = sgNodes.find(n => (n.id as number) === target.nodeId);
      if (target.inputName) displayWidget = target.inputName;
    }
  } else {
    targetNode = sgNodes.find(n => String(n.id) === innerNodeId);
  }

  const title = ((targetNode?.title as string) || (targetNode?.type as string) || '').trim();
  if (BLAND_WIDGET_NAMES.has(displayWidget.toLowerCase())) {
    // Bland widget names collapse into the node title — there's no
    // meaningful second half to disclose in a tooltip.
    return { label: title || titleCase(displayWidget) };
  }
  const widgetLabel = titleCase(displayWidget);
  return title ? { label: widgetLabel, scopeLabel: title } : { label: widgetLabel };
}

/**
 * Resolve each proxyWidget entry into a `(innerNodeId, widgetName)` pair
 * using compound IDs for subgraph-input (`-1`) entries so they line up
 * with the flattener's IDs (e.g. `98:6`). Used by the form↔advanced dedup
 * filter to compare against the form's `bindNodeId|bindWidgetName` keys
 * without tripping on the `-1` raw form.
 */
export function resolveProxyBoundKeys(
  wrapperNode: Record<string, unknown>,
  proxyWidgets: string[][],
  workflow: Record<string, unknown>,
): Array<{ nodeId: string; widgetName: string }> {
  const sg = findSubgraphDef(wrapperNode, workflow);
  const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = (sg?.links || []) as Array<Record<string, unknown>>;
  const sgInputs = (sg?.inputs || []) as Array<Record<string, unknown>>;
  const slotTargets = buildSlotTargetMap(sgNodes, sgLinks);
  const wrapperId = String(wrapperNode.id ?? '');
  return proxyWidgets.map(([innerId, widgetName]) => {
    if (innerId === '-1') {
      const sgIdx = sgInputs.findIndex(
        (inp) => (inp as Record<string, unknown>).name === widgetName,
      );
      const target = sgIdx >= 0 ? slotTargets.get(sgIdx) : undefined;
      if (target) {
        const compound = wrapperId ? `${wrapperId}:${target.nodeId}` : String(target.nodeId);
        return { nodeId: compound, widgetName: target.inputName || widgetName };
      }
    }
    // Non-subgraph-input entries: the inner node is a direct subgraph node.
    // Prepend the wrapper id so keys align with the flattener's compound ids.
    const compound = wrapperId ? `${wrapperId}:${innerId}` : innerId;
    return { nodeId: compound, widgetName };
  });
}

/**
 * Resolve a human-readable label for each proxyWidget entry.
 *
 *   1. When innerNodeId is "-1" (subgraph-self), follow the subgraph link
 *      with `origin_id === -10` whose slot matches this widget to find the
 *      actual target node and input.
 *   2. If the subgraph input has an explicit `label` or `localized_name`,
 *      prefer it.
 *   3. Use the resolved target node's title + target input name; collapse
 *      to just the node title when the input name is itself generic.
 */
export function resolveProxyLabels(
  wrapperNode: Record<string, unknown>,
  proxyWidgets: string[][],
  workflow: Record<string, unknown>,
): string[] {
  // Composite-string form kept for back-compat with existing tests / helpers
  // that only need a single display string.
  return resolveProxyLabelParts(wrapperNode, proxyWidgets, workflow).map(
    p => (p.scopeLabel ? `${p.scopeLabel} · ${p.label}` : p.label),
  );
}

/**
 * Structured variant of `resolveProxyLabels` — returns the widget portion
 * and the node-scope portion separately so the AdvancedSetting consumer
 * can render them independently (main label vs tooltip).
 */
export function resolveProxyLabelParts(
  wrapperNode: Record<string, unknown>,
  proxyWidgets: string[][],
  workflow: Record<string, unknown>,
): ProxyLabelParts[] {
  const sg = findSubgraphDef(wrapperNode, workflow);
  const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = (sg?.links || []) as Array<Record<string, unknown>>;
  const sgInputs = (sg?.inputs || []) as Array<Record<string, unknown>>;
  const slotTargets = buildSlotTargetMap(sgNodes, sgLinks);

  return proxyWidgets.map((entry, i) =>
    labelPartsFor(entry, i, sgNodes, sgInputs, slotTargets),
  );
}

// Resolve the live value + class_type for a proxied inner widget. Modern
// subgraph wrappers carry an EMPTY `widgets_values` at the wrapper level;
// the real values live on each inner node's own `widgets_values`. The widget
// name is mapped to an index via the node's objectInfo schema and the
// node's widgets_values are filtered of frontend-only control values (seed
// `randomize` / `fixed`) before indexing.
function resolveInnerWidgetValue(
  innerNodeId: string,
  widgetName: string,
  sgNodes: Array<Record<string, unknown>>,
  objectInfo: Record<string, Record<string, unknown>>,
  sgInputs?: Array<Record<string, unknown>>,
  slotTargets?: Map<number, SlotTarget>,
): { value: unknown; classType: string | null; resolvedWidgetName: string } {
  let innerNode: Record<string, unknown> | undefined;
  let resolvedWidgetName = widgetName;
  // `-1` is ComfyUI's modern subgraph convention: the proxy targets one of
  // the subgraph's declared inputs, not a direct inner node. Follow the
  // input slot's link down to the consuming node (VAELoader, UNETLoader, …)
  // so we can read its class from objectInfo. `labelPartsFor` already does
  // this walk for the display label; we do the same here for the shape.
  if (innerNodeId === '-1' && sgInputs && slotTargets) {
    const sgIdx = sgInputs.findIndex(
      inp => (inp as Record<string, unknown>).name === widgetName,
    );
    const target = sgIdx >= 0 ? slotTargets.get(sgIdx) : undefined;
    if (target) {
      innerNode = sgNodes.find(n => (n.id as number) === target.nodeId);
      // Use the consumer node's actual input name when looking up the widget
      // index — the subgraph input name may differ (e.g. subgraph input
      // `turbo_lora` → inner `LoraLoaderModelOnly.lora_name`).
      if (target.inputName) resolvedWidgetName = target.inputName;
    }
  } else {
    innerNode = sgNodes.find(n => String(n.id) === innerNodeId);
  }
  if (!innerNode) return { value: null, classType: null, resolvedWidgetName };
  const classType = (innerNode.type as string) || null;
  if (!classType) return { value: null, classType: null, resolvedWidgetName };

  const names = widgetNamesFor(objectInfo, classType);
  const position = names.indexOf(resolvedWidgetName);
  if (position < 0) return { value: null, classType, resolvedWidgetName };

  const values = filteredWidgetValues(innerNode.widgets_values as unknown[] | undefined);
  const value = position < values.length ? values[position] : null;
  return { value, classType, resolvedWidgetName };
}

/**
 * Turn a wrapper's proxyWidgets into AdvancedSetting[].
 *
 * `widgetValues` is the wrapper node's `widgets_values` array. On modern
 * subgraph workflows this is empty — values live on the inner nodes and we
 * fetch them via `resolveInnerWidgetValue`. It is kept as a last-resort
 * fallback for legacy flat workflows where the wrapper still carries the
 * proxied values positionally.
 *
 * Author-proxied widgets are NOT filtered by `isHiddenWidget`: if the
 * template author explicitly exposed a checkpoint / lora / text-encoder
 * name, hiding it defeats the intent. Value-type inference flows through
 * `inferWidgetShape` so COMBO (modern + legacy), INT, FLOAT, STRING,
 * BOOLEAN, and KNOWN_SETTINGS cases all resolve consistently with the
 * raw-widget enumeration path.
 */
export function extractAdvancedSettings(
  proxyWidgets: string[][],
  widgetValues: unknown[],
  objectInfo: Record<string, Record<string, unknown>>,
  labels: string[],
  sgNodes: Array<Record<string, unknown>>,
  scopeLabels?: Array<string | undefined>,
  sgInputs?: Array<Record<string, unknown>>,
  sgLinks?: Array<Record<string, unknown>>,
  // Wrapper attribution for the AdvancedSettings group-by-node render.
  wrapperNodeId?: string,
  wrapperNodeTitle?: string,
): AdvancedSetting[] {
  const slotTargets = sgInputs && sgLinks
    ? buildSlotTargetMap(sgNodes, sgLinks)
    : undefined;
  const settings: AdvancedSetting[] = [];
  for (let i = 0; i < proxyWidgets.length; i++) {
    const [innerNodeId, widgetName] = proxyWidgets[i];
    const label = labels[i] ?? titleCase(widgetName);

    const resolved = resolveInnerWidgetValue(
      innerNodeId, widgetName, sgNodes, objectInfo, sgInputs, slotTargets,
    );
    const value = resolved.classType === null || resolved.value === null
      ? (i < widgetValues.length ? widgetValues[i] : resolved.value)
      : resolved.value;
    const classType = resolved.classType ?? '';

    // Use the resolved inner widget name (for `-1` proxies that redirect
    // through a subgraph input) so `inferWidgetShape` finds the right spec
    // on the consuming node — e.g. proxied `lora_name` → inner
    // `LoraLoaderModelOnly.lora_name` (COMBO).
    const shape = inferWidgetShape(objectInfo, classType, resolved.resolvedWidgetName, value);
    // A select with no options means the schema marked the widget COMBO but
    // failed to surface an options list (defensive: shouldn't happen in
    // ComfyUI's objectInfo). Render as plain text so the field stays usable.
    const type = shape.type === 'select' && (!shape.options || shape.options.length === 0)
      ? 'text'
      : (shape.type ?? 'text');

    settings.push({
      id: widgetName,
      label,
      scopeLabel: scopeLabels?.[i],
      type,
      value,
      min: shape.min,
      max: shape.max,
      step: shape.step,
      options: type === 'select' ? shape.options : undefined,
      proxyIndex: i,
      nodeId: wrapperNodeId,
      nodeTitle: wrapperNodeTitle,
    });
  }
  return settings;
}
