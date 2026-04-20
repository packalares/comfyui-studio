// Shared flattener types. All of these use string node IDs so nested
// subgraph instances (which reuse small numeric ids inside each wrapper)
// don't collide once flattened into one map.

// Normalised link: one unified shape for both top-level array links and
// subgraph-definition object links.
export interface FlatLink {
  id: number;
  origin_id: string;
  origin_slot: number;
  target_id: string;
  target_slot: number;
}

export interface FlatNodeInput {
  name: string;
  /** Points at a FlatLink.id (global, freshly-assigned during flattening). */
  link?: number | null;
  widget?: { name: string };
}

export interface FlatNode {
  id: string;
  type: string;
  inputs: FlatNodeInput[];
  widgets_values: unknown[];
  /** Shown in the LiteGraph UI; forwarded to API prompt as `_meta.title`. */
  title?: string;
  /** LiteGraph node.mode: 0 = normal, 2 = muted, 4 = bypassed. */
  mode?: number;
  /** Per-widget overrides applied by proxyWidgets on a parent wrapper. */
  overrides?: Record<string, unknown>;
}

// Raw LiteGraph link (before global-ID rewriting).
export interface RawLink {
  id: number;
  origin_id: number;
  origin_slot: number;
  target_id: number;
  target_slot: number;
}

export type OutputSubs = Map<
  number,
  Array<{ nodeId: number; slot: number }> | Array<{ nodeId: string; slot: number }>
>;

export type InputSubs = Map<number, { nodeId: string; slot: number }>;

export type SubgraphMap = Map<string, Record<string, unknown>>;

// Cross-scope mutable state accumulated as the flattener recurses.
export interface FlattenState {
  sgMap: SubgraphMap;
  nodes: Map<string, FlatNode>;
  links: FlatLink[];
  nextLinkId: number;
  wrapperOutputs: Map<string, Map<number, { nodeId: string; slot: number }>>;
}
