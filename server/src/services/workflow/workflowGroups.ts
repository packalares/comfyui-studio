// Compute litegraph group membership for nodes present in an api-prompt.
//
// Litegraph "groups" are titled colored rectangles. Membership is positional:
// a node belongs to a group when their bounding boxes overlap. Each node is
// assigned to exactly one group — the smallest-area overlapping group
// (ties broken by lowest group id).
//
// Subgraph support: some workflows contain subgraph instances whose real
// nodes/groups live in `workflow.definitions.subgraphs[]`. Api-prompt keys for
// inner nodes use a colon-separated prefix derived from the chain of instance
// node ids, e.g. "130:105" for a node with id 105 inside instance node 130.

import type { ApiPrompt } from './prompt/types.js';

export interface WorkflowGroupNode {
  id: string;
  classType: string;
  title: string;
}

export interface WorkflowGroup {
  id: number;
  title: string;
  color?: string;
  nodes: WorkflowGroupNode[];
}

// A litegraph bounding box: [x, y, w, h]
type Rect = [number, number, number, number];

type LiteNode = Record<string, unknown>;
type LiteGroup = Record<string, unknown>;

interface SubgraphDef {
  id: string;
  nodes: LiteNode[];
  groups: LiteGroup[];
}

interface GroupEntry {
  title: string;
  color?: string;
  bounding: Rect;
  area: number;
  // original id within its level — used only for tie-breaking
  origId: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function parseRect(raw: unknown): Rect {
  if (Array.isArray(raw) && raw.length >= 4) {
    return [Number(raw[0]), Number(raw[1]), Number(raw[2]), Number(raw[3])];
  }
  return [0, 0, 0, 0];
}

function parseSize(raw: unknown): [number, number] {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    return [Number(r[0] ?? 200), Number(r[1] ?? 100)];
  }
  if (Array.isArray(raw) && raw.length >= 2) {
    return [Number(raw[0]), Number(raw[1])];
  }
  return [200, 100];
}

// Parse one level's groups into sorted GroupEntry[]. Sorted ascending by area
// then origId so the first match is always the smallest/lowest-id group.
function parseSortedGroups(rawGroups: LiteGroup[]): GroupEntry[] {
  const entries: GroupEntry[] = [];
  for (const g of rawGroups) {
    const origId = typeof g.id === 'number' ? g.id : Number(g.id ?? 0);
    const title = typeof g.title === 'string' ? g.title : '';
    const color = typeof g.color === 'string' ? g.color : undefined;
    const bounding = parseRect(g.bounding);
    entries.push({ title, color, bounding, area: bounding[2] * bounding[3], origId });
  }
  entries.sort((a, b) => a.area - b.area || a.origId - b.origId);
  return entries;
}

// Collect WorkflowGroup results from one level (nodes[] + groups[]) and recurse
// into any subgraph instances found at this level.
//
// keyPrefix: api-prompt key prefix for this level, e.g. "" at top, "130:" one
//   level down, "130:140:" two levels down.
// visitedSubgraphIds: set of subgraph ids on the current call stack — guards
//   against infinite recursion if a subgraph ever references itself.
function collectLevel(
  nodes: LiteNode[],
  rawGroups: LiteGroup[],
  keyPrefix: string,
  apiPrompt: ApiPrompt,
  subgraphsById: Map<string, SubgraphDef>,
  visitedSubgraphIds: Set<string>,
  out: Array<{ title: string; color?: string; nodes: WorkflowGroupNode[] }>,
): void {
  const sortedGroups = parseSortedGroups(rawGroups);

  // Map from group index in sortedGroups to accumulated member nodes.
  // We use index rather than origId because origIds are only unique within a
  // level and we need stable buckets here.
  const buckets = new Map<number, WorkflowGroupNode[]>();
  for (let i = 0; i < sortedGroups.length; i++) {
    buckets.set(i, []);
  }

  for (const node of nodes) {
    const nodeId = String(node.id ?? '');
    const apiKey = keyPrefix + nodeId;

    if (apiKey in apiPrompt) {
      const promptEntry = apiPrompt[apiKey];
      const classType = promptEntry.class_type ?? (typeof node.type === 'string' ? node.type : '');

      const rawTitle = node.title;
      let title: string;
      if (typeof rawTitle === 'string' && rawTitle.length > 0) {
        title = rawTitle;
      } else if (typeof promptEntry._meta?.title === 'string' && promptEntry._meta.title.length > 0) {
        title = promptEntry._meta.title;
      } else {
        title = classType;
      }

      const rawPos = node.pos;
      const pos: [number, number] = Array.isArray(rawPos) && rawPos.length >= 2
        ? [Number(rawPos[0]), Number(rawPos[1])]
        : [0, 0];
      const size = parseSize(node.size);
      // Apply ±30 title-bar adjustment: nodes overlap groups from the top.
      const nodeRect: Rect = [pos[0], pos[1] - 30, size[0], size[1] + 30];

      // First match in ascending-area-sorted list = smallest-area overlapping group.
      for (let i = 0; i < sortedGroups.length; i++) {
        if (rectsOverlap(sortedGroups[i].bounding, nodeRect)) {
          buckets.get(i)!.push({ id: apiKey, classType, title });
          break;
        }
      }
    }

    // Recurse into subgraph instances regardless of whether they appear in
    // apiPrompt — inner nodes may still produce api-prompt entries.
    const nodeType = typeof node.type === 'string' ? node.type : '';
    if (nodeType && subgraphsById.has(nodeType) && !visitedSubgraphIds.has(nodeType)) {
      const def = subgraphsById.get(nodeType)!;
      const childPrefix = keyPrefix + nodeId + ':';
      const childVisited = new Set(visitedSubgraphIds);
      childVisited.add(nodeType);
      collectLevel(
        def.nodes,
        def.groups,
        childPrefix,
        apiPrompt,
        subgraphsById,
        childVisited,
        out,
      );
    }
  }

  // Append non-empty groups from this level to out.
  for (let i = 0; i < sortedGroups.length; i++) {
    const members = buckets.get(i)!;
    if (members.length > 0) {
      const g = sortedGroups[i];
      out.push({ title: g.title, color: g.color, nodes: members });
    }
  }
}

/**
 * Derive group assignments from a litegraph workflow JSON and the
 * corresponding stable api-prompt. Handles subgraphed workflows where the
 * real nodes/groups live in `workflow.definitions.subgraphs[]`.
 *
 * Returns all groups (across top level and subgraphs) that contain at least
 * one node present in the api-prompt. Group `id` fields are re-numbered
 * sequentially (0, 1, 2, …) so top-level and subgraph groups never collide.
 *
 * @param workflow  - Raw litegraph workflow JSON.
 * @param apiPrompt - Stable api-prompt keyed by litegraph node id (as string).
 */
export function computeWorkflowGroups(
  workflow: Record<string, unknown>,
  apiPrompt: ApiPrompt,
): WorkflowGroup[] {
  const topNodes: LiteNode[] = Array.isArray(workflow.nodes)
    ? (workflow.nodes as LiteNode[])
    : [];
  const topGroups: LiteGroup[] = Array.isArray(workflow.groups)
    ? (workflow.groups as LiteGroup[])
    : [];

  // Build subgraph lookup from definitions.
  const subgraphsById = new Map<string, SubgraphDef>();
  const defsRaw = workflow.definitions;
  if (defsRaw && typeof defsRaw === 'object') {
    const subgraphsRaw = (defsRaw as Record<string, unknown>).subgraphs;
    if (Array.isArray(subgraphsRaw)) {
      for (const sg of subgraphsRaw as Array<Record<string, unknown>>) {
        const id = typeof sg.id === 'string' ? sg.id : '';
        if (!id) continue;
        subgraphsById.set(id, {
          id,
          nodes: Array.isArray(sg.nodes) ? (sg.nodes as LiteNode[]) : [],
          groups: Array.isArray(sg.groups) ? (sg.groups as LiteGroup[]) : [],
        });
      }
    }
  }

  const raw: Array<{ title: string; color?: string; nodes: WorkflowGroupNode[] }> = [];
  collectLevel(topNodes, topGroups, '', apiPrompt, subgraphsById, new Set(), raw);

  // Re-number ids sequentially so UI keys never collide across levels.
  return raw.map((g, idx) => ({ id: idx, title: g.title, color: g.color, nodes: g.nodes }));
}
