// Wave 8: Extract SHA256 hash hints and base-model context from a LiteGraph
// workflow. Two hint sources:
//   1. `workflow.extra?.Hashes` — CivitAI-style per-filename hash map.
//   2. `node.properties.models[].sha256` — per-entry inline hash (uncommon
//      but valid per the workflow schema extension).

export interface HashHint {
  nodeId: string;
  widgetName: string;
  filename: string;
  sha256?: string;
  baseModelHint?: string;
}

interface WorkflowNode {
  id: number | string;
  type?: string;
  widgets_values?: unknown[];
  inputs?: Array<{ name: string; widget?: { name: string } }>;
  outputs?: Array<{ name: string; widget?: { name: string } }>;
  properties?: {
    models?: Array<{ name?: string; sha256?: string }>;
    [k: string]: unknown;
  };
}

interface LiteGraphWorkflow {
  nodes?: WorkflowNode[];
  extra?: {
    Hashes?: Record<string, { sha256?: string }>;
    [k: string]: unknown;
  };
}

function asWorkflow(workflow: unknown): LiteGraphWorkflow | null {
  if (!workflow || typeof workflow !== 'object') return null;
  return workflow as LiteGraphWorkflow;
}

function widgetNameAtIndex(node: WorkflowNode, index: number): string {
  // Try inputs[].widget.name first (newer ComfyUI widget-as-input pattern).
  const inp = node.inputs ?? [];
  const widgetInputs = inp.filter((i) => i.widget?.name);
  if (widgetInputs[index]?.widget?.name) return widgetInputs[index].widget!.name;
  return String(index);
}

/**
 * Extract hash hints from both `extra.Hashes` and per-node
 * `properties.models[]`. One HashHint per (nodeId, widgetIndex) pair that
 * holds a string widget value matching a model filename.
 */
export function extractHashHints(workflow: unknown): HashHint[] {
  const wf = asWorkflow(workflow);
  if (!wf || !Array.isArray(wf.nodes)) return [];

  const extraHashes: Record<string, string> = {};
  const rawHashes = wf.extra?.Hashes;
  if (rawHashes && typeof rawHashes === 'object') {
    for (const [key, val] of Object.entries(rawHashes)) {
      if (val?.sha256 && typeof val.sha256 === 'string') {
        extraHashes[key.toLowerCase()] = val.sha256.toLowerCase();
      }
    }
  }

  const hints: HashHint[] = [];

  for (const node of wf.nodes) {
    const nodeId = String(node.id);
    const values = node.widgets_values ?? [];
    const propsModels = node.properties?.models ?? [];

    // Build a per-name lookup from properties.models for inline sha256.
    const propsSha256: Record<string, string> = {};
    for (const pm of propsModels) {
      if (pm.name && pm.sha256) {
        propsSha256[pm.name.toLowerCase()] = pm.sha256.toLowerCase();
      }
    }

    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (typeof val !== 'string' || val.length === 0) continue;
      // Widget values that look like model filenames (have an extension).
      if (!val.includes('.')) continue;
      const filename = val;
      const filenameLower = filename.toLowerCase();
      const baseLower = filenameLower.includes('/')
        ? (filenameLower.split('/').pop() ?? filenameLower)
        : filenameLower;

      const sha256 =
        propsSha256[filenameLower] ??
        propsSha256[baseLower] ??
        extraHashes[filenameLower] ??
        extraHashes[baseLower] ??
        undefined;

      hints.push({
        nodeId,
        widgetName: widgetNameAtIndex(node, i),
        filename,
        sha256,
        baseModelHint: inferBaseModelFromContext(workflow, nodeId) ?? undefined,
      });
    }
  }

  return hints;
}

/**
 * Guess base model from node type and widget values for a specific node.
 * Returns null when no confident signal is found.
 */
export function inferBaseModelFromContext(
  workflow: unknown,
  nodeId: string,
): string | null {
  const wf = asWorkflow(workflow);
  if (!wf || !Array.isArray(wf.nodes)) return null;

  const node = wf.nodes.find((n) => String(n.id) === nodeId);
  if (!node) return null;

  const type = (node.type ?? '').toLowerCase();
  const values = node.widgets_values ?? [];
  const textValues = values
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toLowerCase());
  const allText = [type, ...textValues].join(' ');

  if (/flux/.test(allText)) return 'flux1';
  if (/sdxl|xl/.test(allText)) return 'sdxl';
  if (/wan/.test(allText)) return 'wan';
  if (/sd1|1\.5|v1-5|v1_5/.test(allText)) return 'sd1';
  if (/sd2|2\.1|v2-1/.test(allText)) return 'sd2';

  return null;
}
