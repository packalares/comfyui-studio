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
      const parts = id.split(':');
      if (parts.length < 3) continue;
      const nodeId = parts[1];
      const widgetName = parts.slice(2).join(':');
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
    if (!(props?.proxyWidgets && Array.isArray(props.proxyWidgets))) continue;
    const wv = (node.widgets_values || []) as unknown[];
    for (const val of proxyEntries) {
      if (val.proxyIndex < wv.length) wv[val.proxyIndex] = val.value;
    }
    node.widgets_values = wv;
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
