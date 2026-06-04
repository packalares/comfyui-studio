// Advanced-settings application — extracted from `routes/generate.routes.ts`
// so the `/api/generate` HTTP handler AND the chat `generate_image` tool both
// drive the same widget-override pipeline. Behavior is unchanged from the
// original inline helpers; only the location moved.
//
// Two override flavors land in `advancedSettings`:
//   * Proxy widgets (`proxyIndex >= 0`) — values to splice into a wrapper
//     node's `widgets_values` array BEFORE the workflow → API conversion.
//   * Raw-node widgets (key starts with `node:<nodeId>:<widgetName>`,
//     `proxyIndex: -1`) — values to inject onto the API prompt's node
//     entries AFTER conversion.

export interface AdvancedSettingValue { proxyIndex: number; value: unknown }

export interface SplitOverrides {
  proxyEntries: Array<{ proxyIndex: number; value: unknown }>;
  nodeOverrides: Record<string, Record<string, unknown>>;
}

export function splitAdvancedSettings(advancedSettings: unknown): SplitOverrides {
  const proxyEntries: Array<{ proxyIndex: number; value: unknown }> = [];
  const nodeOverrides: Record<string, Record<string, unknown>> = {};
  if (!advancedSettings || typeof advancedSettings !== 'object') {
    return { proxyEntries, nodeOverrides };
  }
  for (const [id, val] of Object.entries(advancedSettings as Record<string, AdvancedSettingValue>)) {
    if (!val || typeof val !== 'object') continue;
    if (typeof val.proxyIndex === 'number' && val.proxyIndex >= 0) {
      proxyEntries.push(val);
      continue;
    }
    if (id.startsWith('node:')) {
      // id format: "node:<nodeId>:<widgetName>". For subgraph-internal
      // widgets, nodeId is the flattener's compound id ("238:232") so the
      // string contains ≥ 2 colons after "node:". Widget names are Python
      // identifiers (no colons), so the LAST colon is always the
      // nodeId/widgetName boundary — regardless of subgraph nesting depth.
      const lastColon = id.lastIndexOf(':');
      if (lastColon < 'node:'.length) continue;
      const nodeId = id.slice('node:'.length, lastColon);
      const widgetName = id.slice(lastColon + 1);
      if (!nodeId || !widgetName) continue;
      if (!nodeOverrides[nodeId]) nodeOverrides[nodeId] = {};
      nodeOverrides[nodeId][widgetName] = val.value;
    }
  }
  return { proxyEntries, nodeOverrides };
}

export function applyProxyOverrides(
  workflow: Record<string, unknown>,
  proxyEntries: Array<{ proxyIndex: number; value: unknown }>,
): void {
  if (proxyEntries.length === 0) return;
  const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  for (const node of topNodes) {
    const props = node.properties as Record<string, unknown> | undefined;
    const proxy = props?.proxyWidgets;
    if (!Array.isArray(proxy)) continue;
    const proxyLen = proxy.length;
    // Modern subgraph wrappers store widgets_values=[] (values live on inner
    // nodes; flattener resolves defaults via proxyWidgets→inner). The old
    // `if (val.proxyIndex < wv.length)` guard silently dropped every override
    // when wv was empty.
    //
    // Fix: grow wv to proxyLen, filling un-overridden slots with `null`.
    // Both downstream consumers already treat null as "skip, use inner
    // default" (flatten/wrappers.ts:139 and flatten/unboundSlots.ts:77),
    // so padded nulls preserve the unchanged-slot behaviour exactly while
    // making room for the user's overrides to land in their proxyIndex.
    const wv = ((node.widgets_values || []) as unknown[]).slice();
    while (wv.length < proxyLen) wv.push(null);
    for (const val of proxyEntries) {
      if (val.proxyIndex >= 0 && val.proxyIndex < proxyLen) {
        wv[val.proxyIndex] = val.value;
      }
    }
    node.widgets_values = wv;
    // NOTE: only the first wrapper node with proxyWidgets is patched here.
    // Multi-wrapper support is intentionally not implemented: today's
    // `buildTemplateBundle` (templateWidgets.routes.ts → findWrapperNode) only
    // extracts AdvancedSettings from the first wrapper, so multi-wrapper
    // proxyEntries are never sent to this function. If multi-wrapper support is
    // added to extractAdvancedSettings callers, this break must be removed and
    // proxyEntries must carry a `wrapperNodeId` discriminator so each entry
    // routes to its own wrapper.
    // TODO: see templateWidgets.routes.ts `findWrapperNode` for the single-
    // wrapper limitation entry point.
    break;
  }
}

export function applyNodeOverrides(
  apiPrompt: Record<string, { inputs?: Record<string, unknown> }>,
  nodeOverrides: Record<string, Record<string, unknown>>,
): void {
  for (const [nodeId, overrides] of Object.entries(nodeOverrides)) {
    const entry = apiPrompt[nodeId];
    if (!entry?.inputs) continue;
    for (const [widgetName, value] of Object.entries(overrides)) {
      entry.inputs[widgetName] = value;
    }
  }
}
