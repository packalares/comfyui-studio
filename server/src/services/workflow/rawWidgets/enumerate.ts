// Enumeration + advanced-setting builder for the "Expose fields" modal
// and the generate-time nodeOverrides pipeline.

import type {
  AdvancedSetting,
  EnumeratedWidget,
} from '../../../contracts/workflow.contract.js';
import * as exposedWidgets from '../../exposedWidgets.js';
import { isEnumerableWidget, titleCase } from '../constants.js';
import { getObjectInfo } from '../objectInfo.js';
import { computeFormClaimedWidgets } from './claimed.js';
import { findSubgraphDef } from '../proxyLabels.js';
import {
  filteredWidgetValues,
  inferWidgetShape,
  widgetNamesFor,
} from './shapes.js';
import { walkSubgraphWidgets } from './subgraphWalk.js';

// Build a single EnumeratedWidget entry.
function buildEnumeratedEntry(
  node: Record<string, unknown>,
  widgetName: string,
  value: unknown,
  classType: string,
  objectInfo: Record<string, Record<string, unknown>>,
  savedSet: Set<string>,
  formClaimed: boolean,
): EnumeratedWidget {
  const nodeId = String(node.id);
  const shape = inferWidgetShape(objectInfo, classType, widgetName, value);
  return {
    nodeId,
    nodeType: classType,
    nodeTitle: (node.title as string | undefined) || undefined,
    widgetName,
    label: titleCase(widgetName),
    value,
    type: shape.type ?? 'number',
    min: shape.min,
    max: shape.max,
    step: shape.step,
    options: shape.options,
    exposed: savedSet.has(`${nodeId}|${widgetName}`),
    formClaimed,
  };
}

/**
 * Enumerate raw-node widgets. Every editable widget is returned; those
 * already driven by the main form (prompt + formInputs) are flagged
 * `formClaimed: true` so the frontend modal can hide them from the
 * "Edit advanced fields" list while still letting the main Studio page
 * use their default values (e.g. pre-filling the Prompt textarea with
 * the positive CLIPTextEncode's default text).
 *
 * Wrapper-node widgets are skipped entirely — they're handled by the
 * proxy-widget pipeline in `proxyLabels.ts`.
 */
export async function enumerateTemplateWidgets(
  workflow: Record<string, unknown>,
  templateName: string,
): Promise<EnumeratedWidget[]> {
  const objectInfo = await getObjectInfo();
  const saved = exposedWidgets.getForTemplate(templateName);
  const savedSet = new Set(saved.map(e => `${e.nodeId}|${e.widgetName}`));
  const formClaimedSet = computeFormClaimedWidgets(workflow, objectInfo, templateName);

  const out: EnumeratedWidget[] = [];
  const nodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  for (const node of nodes) {
    const classType = (node.type as string | undefined) || (node.class_type as string | undefined);
    if (!classType) continue;
    const props = node.properties as Record<string, unknown> | undefined;
    if (props?.proxyWidgets) continue; // skip wrappers

    const wv = filteredWidgetValues(node.widgets_values as unknown[] | undefined);
    if (wv.length === 0) continue;

    const names = widgetNamesFor(objectInfo, classType);
    const nodeId = String(node.id);
    for (let i = 0; i < wv.length && i < names.length; i++) {
      const widgetName = names[i];
      if (!isEnumerableWidget(widgetName)) continue;
      const isClaimed = formClaimedSet.has(`${nodeId}|${widgetName}`);
      out.push(buildEnumeratedEntry(node, widgetName, wv[i], classType, objectInfo, savedSet, isClaimed));
    }
  }

  // Inner-subgraph widgets — runs AFTER the top-level pass so the existing
  // top-level enumeration stays byte-identical. Any buried widget that the
  // wrapper's proxyWidgets already surfaces is skipped by the walker.
  for (const node of nodes) {
    const props = node.properties as Record<string, unknown> | undefined;
    if (!props?.proxyWidgets) continue;
    walkSubgraphWidgets(node, workflow, String(node.id), objectInfo, savedSet, out, 1);
  }

  return out;
}

// Depth cap mirrors subgraphWalk.ts MAX_SUBGRAPH_DEPTH; guards against
// self-referential subgraph defs.
const RAW_WIDGET_MAX_DEPTH = 8;

/**
 * Flatten every node addressable from the workflow root — top level plus
 * every nested subgraph definition — into a single Map keyed by the same
 * compound IDs the flattener emits (`parentInstanceId:innerNodeId`,
 * recursively). Inner-node lookups for exposed widgets like
 * `340:314|text` need this; the legacy top-level-only map silently
 * dropped any entry whose nodeId wasn't a bare top-level instance id.
 */
function flattenNodesById(
  workflow: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const walk = (
    nodes: Array<Record<string, unknown>>,
    prefix: string,
    depth: number,
  ): void => {
    if (depth > RAW_WIDGET_MAX_DEPTH) return;
    for (const n of nodes) {
      const localId = String(n.id);
      const compoundId = prefix ? `${prefix}:${localId}` : localId;
      map.set(compoundId, n);
      const props = n.properties as Record<string, unknown> | undefined;
      if (!props?.proxyWidgets) continue;
      const sgDef = findSubgraphDef(n, workflow);
      if (!sgDef) continue;
      const inner = (sgDef.nodes || []) as Array<Record<string, unknown>>;
      walk(inner, compoundId, depth + 1);
    }
  };
  walk((workflow.nodes || []) as Array<Record<string, unknown>>, '', 0);
  return map;
}

/**
 * Build AdvancedSetting entries for user-exposed raw-node widgets. Uses
 * `proxyIndex: -1` as the marker that routes the value through
 * `nodeOverrides` in /generate.
 */
export function buildRawWidgetSettings(
  workflow: Record<string, unknown>,
  exposed: Array<{ nodeId: string; widgetName: string }>,
  objectInfo: Record<string, Record<string, unknown>>,
  templateName?: string,
): AdvancedSetting[] {
  const result: AdvancedSetting[] = [];
  const byId = flattenNodesById(workflow);
  // Exclude anything already driven by the main form (positive prompt + upload bindings) —
  // otherwise stale entries in the saved exposed-widgets JSON would render in the Advanced
  // Settings panel at the same time the main Prompt textarea is driving the same widget.
  const formClaimed = templateName
    ? computeFormClaimedWidgets(workflow, objectInfo, templateName)
    : new Set<string>();
  for (const e of exposed) {
    if (formClaimed.has(`${e.nodeId}|${e.widgetName}`)) continue;
    const node = byId.get(e.nodeId);
    if (!node) continue;
    const classType = (node.type as string | undefined) || (node.class_type as string | undefined);
    if (!classType) continue;
    const names = widgetNamesFor(objectInfo, classType);
    const idx = names.indexOf(e.widgetName);
    if (idx < 0) continue;
    const wv = filteredWidgetValues(node.widgets_values as unknown[] | undefined);
    if (idx >= wv.length) continue;
    const value = wv[idx];
    const shape = inferWidgetShape(objectInfo, classType, e.widgetName, value);
    // Split the scope ("TextEncodeAceStepAudio1.5") off the primary label so
    // the UI can render the widget name big and tuck the node identity under
    // a tooltip. The untitled fallback uses classType, matching the previous
    // combined-label behaviour.
    const scopeLabel = (node.title as string | undefined) || classType;
    result.push({
      id: `node:${e.nodeId}:${e.widgetName}`,
      label: titleCase(e.widgetName),
      scopeLabel,
      type: shape.type ?? 'number',
      value,
      min: shape.min,
      max: shape.max,
      step: shape.step,
      options: shape.options,
      proxyIndex: -1,
    });
  }
  return result;
}
