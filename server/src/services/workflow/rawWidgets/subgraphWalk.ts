// Walks inner-subgraph nodes to produce EnumeratedWidget entries for
// widgets buried inside wrapper instances. Mirrors the flattener's
// compound-ID convention (`parentInstanceId:innerNodeId`) so any widget
// enumerated here routes through the generate-time nodeOverrides path
// without extra plumbing — `apiPrompt[flatNodeId]` is the same key the
// flattener emits.

import type { EnumeratedWidget } from '../../../contracts/workflow.contract.js';
import { logger } from '../../../lib/logger.js';
import { isEnumerableWidget, titleCase } from '../constants.js';
import { findSubgraphDef } from '../proxyLabels.js';
import {
  filteredWidgetValues,
  inferWidgetShape,
  widgetNamesFor,
} from './shapes.js';

// Guard against self-referential subgraph graphs where a wrapper's def
// points (directly or transitively) back at itself. Depth 8 is higher than
// any real author-produced template depth we've seen.
const MAX_SUBGRAPH_DEPTH = 8;

// Build a lookup set of `(innerNodeId|widgetName)` for a wrapper's proxy
// list so the walker can skip anything the proxy pipeline already surfaces.
function buildProxySkipSet(
  wrapper: Record<string, unknown>,
): Set<string> {
  const skip = new Set<string>();
  const props = wrapper.properties as Record<string, unknown> | undefined;
  const list = props?.proxyWidgets as unknown;
  if (!Array.isArray(list)) return skip;
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const innerId = String(entry[0]);
    const widgetName = String(entry[1]);
    // `-1` = subgraph-self pin, not an inner-node claim — carries no
    // information about which buried node is already covered.
    if (innerId === '-1') continue;
    skip.add(`${innerId}|${widgetName}`);
  }
  return skip;
}

// Split the inner-widget display into primary label (widget name) and
// scope disclosure (subgraph + node). The UI renders the two halves
// independently: the widget name sits on the form row and the scope
// hides behind a tooltip.
function buildInnerLabelParts(
  subgraphName: string,
  innerNode: Record<string, unknown>,
  classType: string,
  widgetName: string,
): { label: string; scopeLabel: string } {
  const innerTitle = (innerNode.title as string | undefined)?.trim();
  const nodeLabel = innerTitle || classType;
  return {
    label: titleCase(widgetName),
    scopeLabel: `${subgraphName} · ${nodeLabel}`,
  };
}

// Emit the enumerated entries for a single leaf (non-wrapper) inner node.
function emitLeafEntries(
  innerNode: Record<string, unknown>,
  classType: string,
  scopePrefix: string,
  subgraphName: string,
  objectInfo: Record<string, Record<string, unknown>>,
  savedSet: Set<string>,
  proxySkip: Set<string>,
  out: EnumeratedWidget[],
): void {
  const wv = filteredWidgetValues(innerNode.widgets_values as unknown[] | undefined);
  if (wv.length === 0) return;
  const names = widgetNamesFor(objectInfo, classType);
  const compoundId = `${scopePrefix}:${innerNode.id}`;
  const localInnerId = String(innerNode.id);

  for (let i = 0; i < wv.length && i < names.length; i++) {
    const widgetName = names[i];
    if (!isEnumerableWidget(widgetName)) continue;
    // Proxy dedupe: the parent's proxyWidgets list already surfaces this
    // (innerNodeId, widgetName) pair via the proxy pipeline. Emitting here
    // would show the same control twice in the expose modal.
    if (proxySkip.has(`${localInnerId}|${widgetName}`)) continue;

    const shape = inferWidgetShape(objectInfo, classType, widgetName, wv[i]);
    const labelParts = buildInnerLabelParts(subgraphName, innerNode, classType, widgetName);
    out.push({
      nodeId: compoundId,
      nodeType: classType,
      nodeTitle: (innerNode.title as string | undefined) || undefined,
      widgetName,
      label: labelParts.label,
      scopeLabel: labelParts.scopeLabel,
      value: wv[i],
      type: shape.type ?? 'number',
      min: shape.min,
      max: shape.max,
      step: shape.step,
      options: shape.options,
      exposed: savedSet.has(`${compoundId}|${widgetName}`),
      // Inner widgets are strictly opt-in via the expose modal; the main
      // form's claim semantics only operate on top-level nodes.
      formClaimed: false,
      scopeName: subgraphName,
    });
  }
}

/**
 * Recursively walk a wrapper's subgraph definition, emitting EnumeratedWidget
 * entries for every buried editable widget (minus those already covered by
 * the parent's `proxyWidgets` list). Nested wrappers recurse with a
 * chained prefix so leaf ids match flattener output (`a:b:c`).
 */
export function walkSubgraphWidgets(
  wrapper: Record<string, unknown>,
  workflow: Record<string, unknown>,
  scopePrefix: string,
  objectInfo: Record<string, Record<string, unknown>>,
  savedSet: Set<string>,
  out: EnumeratedWidget[],
  depth: number,
): void {
  if (depth > MAX_SUBGRAPH_DEPTH) {
    logger.warn('rawWidgets: subgraph walk hit depth cap', {
      scopePrefix,
      depth,
      wrapperType: wrapper.type,
    });
    return;
  }

  const sgDef = findSubgraphDef(wrapper, workflow);
  if (!sgDef) return;
  const sgName = ((sgDef.name as string | undefined) || (wrapper.type as string | undefined) || 'Subgraph').trim();
  const innerNodes = (sgDef.nodes || []) as Array<Record<string, unknown>>;

  // The proxy-skip set is scoped to THIS wrapper — nested wrappers carry
  // their own proxyWidgets lists and must be consulted at their own level.
  const proxySkip = buildProxySkipSet(wrapper);

  for (const innerNode of innerNodes) {
    const classType = (innerNode.type as string | undefined) || (innerNode.class_type as string | undefined);
    if (!classType) continue;

    const props = innerNode.properties as Record<string, unknown> | undefined;
    if (props?.proxyWidgets) {
      // Nested wrapper — recurse; chain the prefix with the wrapper's
      // local id so leaf ids line up with the flattener's compound ids.
      walkSubgraphWidgets(
        innerNode,
        workflow,
        `${scopePrefix}:${innerNode.id}`,
        objectInfo,
        savedSet,
        out,
        depth + 1,
      );
      continue;
    }

    emitLeafEntries(innerNode, classType, scopePrefix, sgName, objectInfo, savedSet, proxySkip, out);
  }
}
