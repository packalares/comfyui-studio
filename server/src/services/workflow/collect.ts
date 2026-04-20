// Recursive node collection for the dependency-check pipeline.
//
// Templates frequently stash loader nodes two or three subgraph levels deep
// — a flat iteration over `workflow.nodes` would miss them. This module
// walks every inline `subgraph.nodes` array as well as the top-level
// `definitions.subgraphs[*].nodes` arrays so the dependency scanner sees
// every declared model.

import type { WorkflowNode } from '../../contracts/workflow.contract.js';

// Narrow type guard: treat any non-null object as a workflow node shape for
// traversal purposes. The WorkflowNode contract tolerates missing fields, so
// downstream consumers still get safe optional access.
function isNodeLike(value: unknown): value is WorkflowNode {
  return value !== null && typeof value === 'object';
}

function nestedNodes(node: WorkflowNode): unknown[] | undefined {
  const sub = (node as { subgraph?: unknown }).subgraph;
  if (!sub || typeof sub !== 'object') return undefined;
  const nodes = (sub as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes : undefined;
}

/**
 * Collect every node from a workflow (top-level + every nested subgraph).
 */
export function collectAllWorkflowNodes(wf: Record<string, unknown>): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      if (!isNodeLike(raw)) continue;
      out.push(raw);
      const nested = nestedNodes(raw);
      if (nested) walk(nested);
    }
  };
  if (Array.isArray(wf.nodes)) walk(wf.nodes);
  const defs = wf.definitions;
  if (defs && typeof defs === 'object') {
    const subgraphs = (defs as { subgraphs?: unknown }).subgraphs;
    if (Array.isArray(subgraphs)) {
      for (const sg of subgraphs) {
        if (!sg || typeof sg !== 'object') continue;
        const nested = (sg as { nodes?: unknown }).nodes;
        if (Array.isArray(nested)) walk(nested);
      }
    }
  }
  return out;
}
