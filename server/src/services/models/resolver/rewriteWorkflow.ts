// Wave 8: Apply on-disk resolution decisions back to the LiteGraph workflow.
// Mutates a deep-cloned copy; never touches the original.

export interface ResolutionAction {
  nodeId: string;
  widgetName: string;
  originalValue: string;
  resolvedSavePath: string;
  resolvedFilename: string;
}

interface StudioRef {
  widgetName: string;
  originalValue: string;
  resolvedSavePath: string;
  resolvedFilename: string;
}

interface MutableNode {
  id: number | string;
  widgets_values?: unknown[];
  properties?: Record<string, unknown>;
}

interface MutableWorkflow {
  nodes?: MutableNode[];
}

/**
 * Build the ComfyUI widget string for a resolved model.
 * When save_path is non-empty, ComfyUI expects `save_path/filename`;
 * otherwise just `filename`.
 */
function buildWidgetValue(save_path: string, filename: string): string {
  return save_path ? `${save_path}/${filename}` : filename;
}

/**
 * Deep-clone the workflow, replace widget values that match `originalValue`
 * for the specified node, and record provenance in
 * `node.properties.studio_original_refs`.
 */
export function applyResolutions(
  workflow: unknown,
  actions: ResolutionAction[],
): unknown {
  // Deep clone — we never mutate the source.
  const clone = JSON.parse(JSON.stringify(workflow)) as MutableWorkflow;

  if (!clone.nodes || !Array.isArray(clone.nodes) || actions.length === 0) {
    return clone;
  }

  // Group actions by nodeId for a single pass over nodes.
  const byNode = new Map<string, ResolutionAction[]>();
  for (const action of actions) {
    const existing = byNode.get(action.nodeId) ?? [];
    existing.push(action);
    byNode.set(action.nodeId, existing);
  }

  for (const node of clone.nodes) {
    const nodeId = String(node.id);
    const nodeActions = byNode.get(nodeId);
    if (!nodeActions || nodeActions.length === 0) continue;

    const values = node.widgets_values;
    if (!Array.isArray(values)) continue;

    if (!node.properties) node.properties = {};
    const refs: StudioRef[] =
      (node.properties.studio_original_refs as StudioRef[] | undefined) ?? [];

    for (const action of nodeActions) {
      // Find the first widget slot whose current value equals originalValue.
      const idx = values.findIndex((v) => v === action.originalValue);
      if (idx === -1) continue;

      const newValue = buildWidgetValue(
        action.resolvedSavePath,
        action.resolvedFilename,
      );
      values[idx] = newValue;

      refs.push({
        widgetName: action.widgetName,
        originalValue: action.originalValue,
        resolvedSavePath: action.resolvedSavePath,
        resolvedFilename: action.resolvedFilename,
      });
    }

    node.properties.studio_original_refs = refs;
  }

  return clone;
}
