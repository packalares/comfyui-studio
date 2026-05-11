import { useEffect, useMemo, useCallback, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Panel,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from 'reactflow';
import dagre from '@dagrejs/dagre';
import 'reactflow/dist/style.css';

import WorkflowCard, { type WfCardStatus, type WfCardData } from './WorkflowCard';
import GraphControls from './GraphControls';
import { humanizeClassType, nodeCategory, type NodeCategory } from './nodeIcon';
import { useNodeStatusMap, type NodeStatus } from './useNodeStatusMap';
import { useJobs } from '../../context/JobsContext';
import { cn } from '../../lib/utils';
import type { WorkflowGroup } from '../../types';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ComfyNode {
  class_type: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
}

type WorkflowJson = Record<string, ComfyNode>;

// Auxiliary / plumbing class_types that exist for wiring or labeling and
// don't represent a meaningful step the user cares about during generation.
function isPlumbing(classType: string): boolean {
  const lc = classType.toLowerCase();
  if (lc === 'reroute' || lc === 'note' || lc === 'bookmark') return true;
  if (lc.startsWith('primitive')) return true;
  if (lc.startsWith('display') || lc.startsWith('show')) return true;
  if (lc.includes('widget') && (lc.includes('tostring') || lc.includes('tofloat') || lc.includes('toint'))) return true;
  if (lc.includes('getnode') || lc.includes('setnode')) return true;
  if (lc.includes('anywhere')) return true; // rgthree "Anything Everywhere"
  if (lc === 'mathexpression') return true;
  return false;
}

// ─── Layout sizing ───────────────────────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT = 60;

const nodeTypes = { workflowNode: WorkflowCard, workflowGroup: WorkflowCard };

const FIT_OPTS = { padding: 0.15, maxZoom: 1.1, duration: 300 };

const baseEdgeStyle = () => ({ stroke: 'var(--color-border, #e2e8f0)', strokeWidth: 1.5 });
const baseMarker = () => ({ type: MarkerType.ArrowClosed, width: 10, height: 10, color: 'var(--color-border, #e2e8f0)' });
const activeMarker = () => ({ type: MarkerType.ArrowClosed, width: 10, height: 10, color: 'var(--color-success, #22c55e)' });

// ─── Dependency graph helpers ────────────────────────────────────────────────

function getInputSourceIds(workflow: WorkflowJson, nodeId: string): string[] {
  const node = workflow[nodeId];
  if (!node?.inputs) return [];
  const out: string[] = [];
  for (const val of Object.values(node.inputs)) {
    if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') out.push(val[0]);
  }
  return out;
}

// nodeId -> direct upstream node ids (raw, includes plumbing).
function buildDepParents(workflow: WorkflowJson): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const id of Object.keys(workflow)) m.set(id, getInputSourceIds(workflow, id));
  return m;
}

// ComfyUI executes in topological order: if any node is running or done, every
// node upstream of it MUST have already run — even if we never saw its WS
// `executed` event. Return all such implied-done ids (raw ids, plumbing too).
function closeImpliedDone(statusMap: Map<string, NodeStatus>, depParents: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const [id, st] of statusMap) if (st === 'running' || st === 'done') stack.push(id);
  while (stack.length) {
    const id = stack.pop()!;
    for (const p of depParents.get(id) ?? []) {
      if (!out.has(p)) {
        out.add(p);
        stack.push(p);
      }
    }
  }
  return out;
}

// ─── Node-level parse ────────────────────────────────────────────────────────

function parseWorkflow(workflowJson: WorkflowJson, mainNodeIds: Set<string> | null) {
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  const usingMainFilter = mainNodeIds !== null && mainNodeIds.size > 0;
  const isTerminal = (ct: string) => /^(SaveImage|SaveVideo|SaveAnimated|Preview)/i.test(ct);

  const keptIds = new Set<string>();
  for (const [id, node] of Object.entries(workflowJson)) {
    if (isPlumbing(node.class_type)) continue;
    if (usingMainFilter) {
      if (mainNodeIds!.has(id) || isTerminal(node.class_type)) keptIds.add(id);
    } else {
      keptIds.add(id);
    }
  }

  function nearestKeptAncestors(nodeId: string, visited: Set<string>): string[] {
    if (visited.has(nodeId)) return [];
    visited.add(nodeId);
    const result: string[] = [];
    for (const srcId of getInputSourceIds(workflowJson, nodeId)) {
      if (keptIds.has(srcId)) result.push(srcId);
      else result.push(...nearestKeptAncestors(srcId, visited));
    }
    return Array.from(new Set(result));
  }

  const seenEdges = new Set<string>();
  for (const [id, node] of Object.entries(workflowJson)) {
    if (!keptIds.has(id)) continue;
    const label = node._meta?.title || humanizeClassType(node.class_type);
    rfNodes.push({
      id,
      type: 'workflowNode',
      position: { x: 0, y: 0 },
      data: { label, category: nodeCategory(node.class_type), iconClassType: node.class_type, status: 'neutral' } satisfies WfCardData,
    });
    for (const srcId of nearestKeptAncestors(id, new Set())) {
      const key = `${srcId}-${id}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      rfEdges.push({ id: key, source: srcId, target: id, style: baseEdgeStyle(), markerEnd: baseMarker() });
    }
  }
  return { rfNodes, rfEdges };
}

// ─── Group-level parse ───────────────────────────────────────────────────────

type GroupNodeData = WfCardData & { memberIds: string[] };

// Collapse the full (plumbing-filtered) node graph down to one card per group.
// Nodes that aren't inside any group become singleton cards so the chain stays
// connected. Edges between two different groups become group→group edges.
function buildGroupGraph(workflowJson: WorkflowJson, groups: WorkflowGroup[]) {
  const { rfNodes, rfEdges } = parseWorkflow(workflowJson, null);
  const renderedIds = new Set(rfNodes.map((n) => n.id));
  const labelOf = new Map<string, string>();
  const classOf = new Map<string, string>();
  for (const n of rfNodes) {
    const d = n.data as WfCardData;
    labelOf.set(n.id, d.label);
    classOf.set(n.id, d.iconClassType);
  }

  const groupNodeIdOf = new Map<string, string>();
  const gNodes: Node[] = [];
  const makeGroupNode = (id: string, data: GroupNodeData): Node => ({ id, type: 'workflowGroup', position: { x: 0, y: 0 }, data });

  for (const g of groups) {
    const members = g.nodes.map((n) => n.id).filter((id) => renderedIds.has(id));
    if (members.length === 0) continue;
    const gnId = `g:${g.id}`;
    for (const id of members) groupNodeIdOf.set(id, gnId);

    const catCount = new Map<NodeCategory, number>();
    for (const id of members) {
      const c = nodeCategory(classOf.get(id) ?? '');
      catCount.set(c, (catCount.get(c) ?? 0) + 1);
    }
    let dominant: NodeCategory = 'misc';
    let best = -1;
    for (const [c, n] of catCount) if (n > best) { best = n; dominant = c; }
    const iconMember = members.find((id) => nodeCategory(classOf.get(id) ?? '') === dominant) ?? members[0];

    gNodes.push(makeGroupNode(gnId, {
      label: g.title || 'Group',
      category: dominant,
      iconClassType: classOf.get(iconMember) ?? '',
      status: 'neutral',
      memberIds: members,
    }));
  }

  for (const id of renderedIds) {
    if (groupNodeIdOf.has(id)) continue;
    const gnId = `g:s:${id}`;
    groupNodeIdOf.set(id, gnId);
    const ct = classOf.get(id) ?? '';
    gNodes.push(makeGroupNode(gnId, {
      label: labelOf.get(id) ?? humanizeClassType(ct),
      category: nodeCategory(ct),
      iconClassType: ct,
      status: 'neutral',
      memberIds: [id],
    }));
  }

  const seen = new Set<string>();
  const gEdges: Edge[] = [];
  for (const e of rfEdges) {
    const a = groupNodeIdOf.get(e.source);
    const b = groupNodeIdOf.get(e.target);
    if (!a || !b || a === b) continue;
    const key = `${a}->${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gEdges.push({ id: key, source: a, target: b, style: baseEdgeStyle(), markerEnd: baseMarker() });
  }
  return { gNodes, gEdges };
}

// ─── dagre layout ────────────────────────────────────────────────────────────

function layoutGraph(nodes: Node[], edges: Edge[], w: number, h: number): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 48, nodesep: 28 });
  for (const node of nodes) g.setNode(node.id, { width: w, height: h });
  for (const edge of edges) if (g.hasNode(edge.source) && g.hasNode(edge.target)) g.setEdge(edge.source, edge.target);
  dagre.layout(g);
  return nodes.map((node) => {
    const pos = g.node(node.id);
    return { ...node, position: { x: pos.x - w / 2, y: pos.y - h / 2 } };
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

type ViewMode = 'simple' | 'advanced';

interface WorkflowGraphProps {
  templateName: string;
  isRunning: boolean;
  apiPrompt: Record<string, unknown> | null;
  mainNodeIds: Set<string> | null;
  groups: WorkflowGroup[];
  errorNodeIds?: string[];
}

export default function WorkflowGraph({ templateName, isRunning, apiPrompt, mainNodeIds, groups, errorNodeIds = [] }: WorkflowGraphProps) {
  const { progress } = useJobs();
  const statusMap = useNodeStatusMap(templateName);
  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  const instanceRef = useRef<ReactFlowInstance | null>(null);
  const lastCenteredRef = useRef<string | null>(null);

  const workflowJson = apiPrompt as WorkflowJson | null;

  const depParents = useMemo(() => (workflowJson ? buildDepParents(workflowJson) : new Map<string, string[]>()), [workflowJson]);

  const isGroupView = viewMode === 'simple' && groups.length > 0;

  const { initialNodes, initialEdges } = useMemo(() => {
    if (!workflowJson) return { initialNodes: [], initialEdges: [] };
    if (isGroupView) {
      const { gNodes, gEdges } = buildGroupGraph(workflowJson, groups);
      return { initialNodes: layoutGraph(gNodes, gEdges, NODE_WIDTH, NODE_HEIGHT), initialEdges: gEdges };
    }
    const { rfNodes, rfEdges } = parseWorkflow(workflowJson, mainNodeIds);
    return { initialNodes: layoutGraph(rfNodes, rfEdges, NODE_WIDTH, NODE_HEIGHT), initialEdges: rfEdges };
  }, [workflowJson, mainNodeIds, groups, isGroupView]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Re-seed when the built graph changes (template or view-mode swap), then
  // open at 100% zoom with the start of the flow near the TOP of the viewport
  // (horizontally centred on the topmost row) so it reads top→down.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    lastCenteredRef.current = null;
    const t = setTimeout(() => {
      const inst = instanceRef.current;
      if (!inst || initialNodes.length === 0) return;
      let topY = Infinity;
      for (const n of initialNodes) if (n.position.y < topY) topY = n.position.y;
      const topRow = initialNodes.filter((n) => n.position.y === topY);
      let minX = Infinity;
      let maxX = -Infinity;
      for (const n of topRow) {
        const w = inst.getNode(n.id)?.width ?? NODE_WIDTH;
        if (n.position.x < minX) minX = n.position.x;
        if (n.position.x + w > maxX) maxX = n.position.x + w;
      }
      const centerX = (minX + maxX) / 2;
      const el = document.querySelector<HTMLElement>('.react-flow');
      const cw = el?.clientWidth ?? 800;
      const ch = el?.clientHeight ?? 600;
      const topMargin = Math.min(Math.max(ch * 0.1, 32), 80);
      inst.setViewport({ x: cw / 2 - centerX, y: topMargin - topY, zoom: 1 }, { duration: 0 });
    }, 60);
    return () => clearTimeout(t);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Implied-done closure + per-id effective status (running > done > pending).
  const effStatusOf = useMemo(() => {
    const implied = closeImpliedDone(statusMap, depParents);
    return (id: string): NodeStatus => {
      const raw = statusMap.get(id);
      if (raw === 'running') return 'running';
      if (raw === 'done' || implied.has(id)) return 'done';
      return 'pending';
    };
  }, [statusMap, depParents]);

  const anyActivity = useMemo(
    () => statusMap.size > 0 && Array.from(statusMap.values()).some((s) => s !== 'pending'),
    [statusMap],
  );

  // RF node ids that should pull a "running" highlight (their incoming edges
  // light up, and we pan to them). In group view: groups holding a running
  // member. In node view: the running nodes themselves.
  const runningIds = useMemo(() => {
    const s = new Set<string>();
    if (isGroupView) {
      for (const n of initialNodes) {
        const ids = (n.data as GroupNodeData).memberIds ?? [];
        if (ids.some((id) => statusMap.get(id) === 'running')) s.add(n.id);
      }
    } else {
      for (const [id, st] of statusMap) if (st === 'running') s.add(id);
    }
    return s;
  }, [isGroupView, initialNodes, statusMap]);

  // Push status / progress into the rendered nodes.
  // After computing the normal running/done/pending status, override to 'error'
  // when the node (or any group member) is in errorNodeIds.
  const errorNodeSet = useMemo(() => new Set(errorNodeIds), [errorNodeIds]);

  useEffect(() => {
    if (!workflowJson) return;
    const subNodeId = progress?.nodeId;
    const subFrac = progress && progress.max > 0 ? Math.max(0, Math.min(1, progress.value / progress.max)) : undefined;

    if (isGroupView) {
      setNodes((nds: Node[]) =>
        nds.map((node: Node) => {
          const ids = (node.data as GroupNodeData).memberIds ?? [];
          let running = 0;
          let done = 0;
          for (const id of ids) {
            const s = effStatusOf(id);
            if (s === 'running') running++;
            else if (s === 'done') done++;
          }
          let status: WfCardStatus = 'neutral';
          let fraction: number | undefined;
          if (anyActivity) {
            if (running > 0) {
              status = 'running';
              const memberSub = subNodeId && ids.includes(subNodeId) ? (subFrac ?? 0) : 0;
              fraction = ids.length > 0 ? Math.max(0, Math.min(1, (done + memberSub) / ids.length)) : 0;
            } else if (ids.length > 0 && done === ids.length) {
              status = 'done';
            } else {
              status = 'pending';
            }
          }
          // Override to error when any group member is a failing node.
          if (errorNodeSet.size > 0 && ids.some(id => errorNodeSet.has(id))) {
            status = 'error';
            fraction = undefined;
          }
          return { ...node, data: { ...node.data, status, progressFraction: fraction } };
        }),
      );
      return;
    }

    setNodes((nds: Node[]) =>
      nds.map((node: Node) => {
        const eff = effStatusOf(node.id);
        let status: WfCardStatus = anyActivity ? eff : 'neutral';
        const fraction = status === 'running' && subNodeId === node.id ? subFrac : undefined;
        // Override to error when this node is a failing node.
        if (errorNodeSet.size > 0 && errorNodeSet.has(node.id)) {
          status = 'error';
        }
        return { ...node, data: { ...node.data, status, progressFraction: fraction } };
      }),
    );
  }, [workflowJson, isGroupView, anyActivity, effStatusOf, progress, errorNodeSet, setNodes]);

  // Edge highlight: light up edges feeding a currently-running node/group.
  useEffect(() => {
    setEdges((eds: Edge[]) =>
      eds.map((e: Edge) => {
        const on = isRunning && runningIds.has(e.target);
        return {
          ...e,
          style: on ? { stroke: 'var(--color-success, #22c55e)', strokeWidth: 2 } : baseEdgeStyle(),
          markerEnd: on ? activeMarker() : baseMarker(),
          animated: on,
        };
      }),
    );
  }, [isRunning, runningIds, setEdges]);

  // Gently pan to the node that needs attention: a failing node takes
  // priority (the run is over, point at the problem); otherwise follow the
  // running node/group as it advances.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    let targetId: string | null = null;
    if (errorNodeSet.size > 0) {
      for (const n of initialNodes) {
        if (errorNodeSet.has(n.id)) { targetId = n.id; break; }
        const ids = (n.data as GroupNodeData).memberIds;
        if (Array.isArray(ids) && ids.some((id) => errorNodeSet.has(id))) { targetId = n.id; break; }
      }
    } else if (isRunning) {
      for (const id of runningIds) { targetId = id; break; }
    }
    if (!targetId) { lastCenteredRef.current = null; return; }
    if (targetId === lastCenteredRef.current) return;
    const n = inst.getNode(targetId);
    if (!n) return;
    lastCenteredRef.current = targetId;
    const w = n.width ?? NODE_WIDTH;
    const h = n.height ?? NODE_HEIGHT;
    inst.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: inst.getZoom(), duration: 500 });
  }, [isRunning, runningIds, errorNodeSet, initialNodes]);

  const onInit = useCallback((instance: ReactFlowInstance) => {
    instanceRef.current = instance;
    // Initial center-on-start is handled by the initialNodes effect above.
    // onInit fires before that effect's setTimeout, so nothing extra needed here.
  }, []);

  if (apiPrompt == null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground gap-2">
        <span className="w-4 h-4 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        Loading workflow graph…
      </div>
    );
  }

  if (nodes.length === 0) return null;

  const toggleBtn = (mode: ViewMode, label: string) => (
    <button type="button" onClick={() => setViewMode(mode)} className={cn('wf-viewtoggle-btn', viewMode === mode && 'is-active')}>
      {label}
    </button>
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      onInit={onInit}
      minZoom={0.2}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnScroll
      panOnDrag
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} size={1.6} color="var(--wf-grid-dot, #d0d0d4)" />
      {groups.length > 0 && (
        <Panel position="top-right">
          <div className="wf-viewtoggle">
            {toggleBtn('simple', 'Simple')}
            {toggleBtn('advanced', 'Advanced')}
          </div>
        </Panel>
      )}
      <GraphControls />
    </ReactFlow>
  );
}
