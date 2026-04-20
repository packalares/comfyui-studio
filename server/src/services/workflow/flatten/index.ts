// Public entry point for the flattener. Constructs the initial FlattenState
// and kicks off `expandScope` on the top-level nodes; returns the global
// node map + link list ready for the resolve / prompt pass.

import { normalizeLinks } from './links.js';
import { expandScope } from './scope.js';
import type { FlatLink, FlatNode, FlattenState, SubgraphMap } from './types.js';

export type { FlatLink, FlatNode, FlatNodeInput, RawLink } from './types.js';
export { normalizeLinks } from './links.js';

/**
 * Recursively flatten a LiteGraph workflow with nested subgraphs into a
 * single list of nodes + links with global IDs. Wrapper nodes are replaced
 * by their inner nodes; external input/output pins (origin_id=-10,
 * target_id=-20) are rewired to the wrapper's outer neighbors so every link
 * in the returned list references real nodes.
 */
export function flattenWorkflow(
  wf: Record<string, unknown>,
): { nodes: Map<string, FlatNode>; links: FlatLink[] } {
  const subgraphDefs = (
    (wf.definitions as Record<string, unknown> | undefined)?.subgraphs || []
  ) as Array<Record<string, unknown>>;
  const sgMap: SubgraphMap = new Map();
  for (const sg of subgraphDefs) sgMap.set(sg.id as string, sg);

  const state: FlattenState = {
    sgMap,
    nodes: new Map(),
    links: [],
    nextLinkId: 1,
    wrapperOutputs: new Map(),
  };

  expandScope(
    state,
    '',
    (wf.nodes || []) as Array<Record<string, unknown>>,
    normalizeLinks((wf.links || []) as unknown[]),
    new Map(),
    new Map(),
    new Map(),
  );

  return { nodes: state.nodes, links: state.links };
}
