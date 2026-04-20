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
import {
  BLAND_WIDGET_NAMES,
  KNOWN_SETTINGS,
  isHiddenWidget,
  titleCase,
} from './constants.js';

interface SlotTarget { nodeId: number; inputName: string }

// Locate the subgraph definition a wrapper node points at. The definition
// lives either inline on the node or in `workflow.definitions.subgraphs`.
function findSubgraphDef(
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
function buildSlotTargetMap(
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

// Resolve a single proxy-widget entry into its best available display label.
function labelFor(
  proxyEntry: string[],
  index: number,
  sgNodes: Array<Record<string, unknown>>,
  sgInputs: Array<Record<string, unknown>>,
  slotTargets: Map<number, SlotTarget>,
): string {
  const [innerNodeId, widgetName] = proxyEntry;
  let targetNode: Record<string, unknown> | undefined;
  let displayWidget = widgetName;

  if (innerNodeId === '-1') {
    const sgInput = sgInputs.find(inp => (inp as Record<string, unknown>).name === widgetName);
    const explicit =
      ((sgInput as Record<string, unknown> | undefined)?.label as string | undefined)
      ?? ((sgInput as Record<string, unknown> | undefined)?.localized_name as string | undefined);
    if (explicit && explicit !== widgetName) return titleCase(explicit);

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
    return title || titleCase(displayWidget);
  }
  const widgetLabel = titleCase(displayWidget);
  return title ? `${title} \u00b7 ${widgetLabel}` : widgetLabel;
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
  const sg = findSubgraphDef(wrapperNode, workflow);
  const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
  const sgLinks = (sg?.links || []) as Array<Record<string, unknown>>;
  const sgInputs = (sg?.inputs || []) as Array<Record<string, unknown>>;
  const slotTargets = buildSlotTargetMap(sgNodes, sgLinks);

  return proxyWidgets.map((entry, i) =>
    labelFor(entry, i, sgNodes, sgInputs, slotTargets),
  );
}

// Look up COMBO option lists from object_info — used to turn string-valued
// widgets like `sampler_name` / `scheduler` into a select dropdown.
function findComboOptions(
  objectInfo: Record<string, Record<string, unknown>>,
  widgetName: string,
): string[] {
  const options: string[] = [];
  for (const [, nodeInfo] of Object.entries(objectInfo)) {
    const info = nodeInfo as {
      input?: {
        required?: Record<string, unknown[]>;
        optional?: Record<string, unknown[]>;
      };
    };
    const allInputs = { ...(info?.input?.required || {}), ...(info?.input?.optional || {}) };
    const spec = allInputs[widgetName];
    if (spec && Array.isArray(spec) && Array.isArray(spec[0])) {
      for (const opt of spec[0]) {
        if (typeof opt === 'string' && !options.includes(opt)) options.push(opt);
      }
      if (options.length > 0) break;
    }
  }
  return options;
}

// Build an AdvancedSetting for one proxy entry. Returns null to skip the
// entry entirely (filename-shaped strings, unknown combos, etc.).
function buildSetting(
  widgetName: string,
  label: string,
  value: unknown,
  proxyIndex: number,
  objectInfo: Record<string, Record<string, unknown>>,
): AdvancedSetting | null {
  const known = KNOWN_SETTINGS[widgetName];
  if (known) {
    return {
      id: widgetName, label,
      type: known.type ?? 'number',
      value, min: known.min, max: known.max, step: known.step,
      proxyIndex,
    };
  }
  if (typeof value === 'boolean') {
    return { id: widgetName, label, type: 'toggle', value, proxyIndex };
  }
  if (typeof value === 'string' && value.length > 0) {
    if (
      value.includes('/') || value.includes('\\') ||
      value.endsWith('.safetensors') || value.endsWith('.pth') ||
      value.endsWith('.ckpt') || value.endsWith('.bin')
    ) return null;
    const comboWidgets = ['sampler_name', 'scheduler', 'aspect_ratio'];
    if (!comboWidgets.includes(widgetName)) return null;
    const options = findComboOptions(objectInfo, widgetName);
    if (options.length === 0) return null;
    return {
      id: widgetName, label, type: 'select', value,
      options: options.map(o => ({ label: o, value: o })),
      proxyIndex,
    };
  }
  if (typeof value === 'number') {
    return {
      id: widgetName, label, type: 'slider', value,
      min: 0, max: Math.max(value * 4, 100),
      step: Number.isInteger(value) ? 1 : 0.1,
      proxyIndex,
    };
  }
  return null;
}

/**
 * Turn a wrapper's proxyWidgets + widgets_values into AdvancedSetting[].
 * Skips widgets flagged hidden by name or type; labels drive display.
 */
export function extractAdvancedSettings(
  proxyWidgets: string[][],
  widgetValues: unknown[],
  objectInfo: Record<string, Record<string, unknown>>,
  labels: string[],
): AdvancedSetting[] {
  const settings: AdvancedSetting[] = [];
  for (let i = 0; i < proxyWidgets.length; i++) {
    const [, widgetName] = proxyWidgets[i];
    if (isHiddenWidget(widgetName)) continue;
    const label = labels[i] ?? titleCase(widgetName);
    const value = i < widgetValues.length ? widgetValues[i] : null;
    const built = buildSetting(widgetName, label, value, i, objectInfo);
    if (built) settings.push(built);
  }
  return settings;
}
