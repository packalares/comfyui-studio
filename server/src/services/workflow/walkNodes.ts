// Shared workflow-node traversal helper.
//
// ComfyUI workflow JSON holds top-level nodes under `workflow.nodes` and
// subgraph-defined nodes under `workflow.definitions.subgraphs[].nodes`.
// Several extractors (gallery metadata, Primitive form-field detection)
// need to iterate over the union of both. Previously each had its own
// near-identical `collectAllNodes` / `collectNodes` implementation —
// same shape, slightly different Node types. DRY'd here, generic over
// the caller's Node type so each callsite keeps its own shape contract.

export interface WorkflowWithSubgraphs<N> {
  nodes?: N[];
  definitions?: { subgraphs?: Array<{ nodes?: N[] }> };
}

/** Collect all nodes from the top level + every subgraph definition. */
export function collectAllNodes<N>(workflow: WorkflowWithSubgraphs<N>): N[] {
  const out: N[] = [];
  if (Array.isArray(workflow.nodes)) out.push(...workflow.nodes);
  const subs = workflow.definitions?.subgraphs;
  if (Array.isArray(subs)) {
    for (const sg of subs) {
      if (Array.isArray(sg.nodes)) out.push(...sg.nodes);
    }
  }
  return out;
}
