import { useEffect, useMemo, useState, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
} from 'reactflow';
import dagre from '@dagrejs/dagre';
import 'reactflow/dist/style.css';

import WorkflowNodeComponent from './WorkflowNode';
import { humanizeClassType, nodeCategory } from './nodeIcon';
import { useNodeStatusMap } from './useNodeStatusMap';
import { useJobs } from '../../context/JobsContext';
import { api } from '../../services/comfyui';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ComfyNode {
  class_type: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
}

type WorkflowJson = Record<string, ComfyNode>;

// Auxiliary / plumbing class_types that exist for wiring or labeling and
// don't represent a meaningful step the user cares about during generation.
// Filtered out from the graph so only "main" nodes show.
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

// ─── Node sizes for dagre layout ─────────────────────────────────────────────

const NODE_WIDTH = 220;
const NODE_HEIGHT = 60;

// ─── Custom node types map (stable reference, defined outside component) ─────

const nodeTypes = { workflowNode: WorkflowNodeComponent };

// ─── Parse workflow JSON into RF nodes + edges ────────────────────────────────

// Pre-built input map for transitive ancestor walks.
function getInputSourceIds(workflow: WorkflowJson, nodeId: string): string[] {
  const node = workflow[nodeId];
  if (!node?.inputs) return [];
  const out: string[] = [];
  for (const val of Object.values(node.inputs)) {
    if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
      out.push(val[0]);
    }
  }
  return out;
}

function parseWorkflow(workflowJson: WorkflowJson, mainNodeIds: Set<string> | null) {
  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // Determine which nodes to render. When `mainNodeIds` is provided (from
  // the template's widget enumeration — same data Studio uses to populate
  // "advanced fields"), show only those + terminal outputs (Save / Preview).
  // Falls back to "filter plumbing only" when bundle fetch failed.
  const usingMainFilter = mainNodeIds !== null && mainNodeIds.size > 0;
  const isTerminal = (ct: string) =>
    /^(SaveImage|SaveVideo|SaveAnimated|Preview)/i.test(ct);

  const keptIds = new Set<string>();
  for (const [id, node] of Object.entries(workflowJson)) {
    if (isPlumbing(node.class_type)) continue;
    if (usingMainFilter) {
      if (mainNodeIds!.has(id) || isTerminal(node.class_type)) keptIds.add(id);
    } else {
      keptIds.add(id);
    }
  }

  // For each kept node, walk upstream through filtered intermediates to find
  // the nearest kept ancestor(s). Lets us draw a direct edge A→B even when
  // a chain of plumbing nodes sits between A and B in the raw workflow.
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
      position: { x: 0, y: 0 }, // dagre will set real positions
      data: {
        label,
        classType: node.class_type,
        category: nodeCategory(node.class_type),
        status: 'pending',
      },
    });

    // Collapse the input fan-in through filtered intermediates into direct
    // ancestor→this edges. Dedup by source-target pair to avoid parallel
    // duplicates when multiple inputs route to the same upstream node.
    for (const srcId of nearestKeptAncestors(id, new Set())) {
      const key = `${srcId}-${id}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      rfEdges.push({
        id: key,
        source: srcId,
        target: id,
        style: { stroke: 'var(--color-border, #e2e8f0)', strokeWidth: 1.5 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 10,
          height: 10,
          color: 'var(--color-border, #e2e8f0)',
        },
      });
    }
  }

  return { rfNodes, rfEdges };
}

// ─── Auto-layout with dagre ───────────────────────────────────────────────────

function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 40, nodesep: 20 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    // Only add edge if both source and target nodes exist
    if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  return nodes.map(node => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

interface WorkflowGraphProps {
  templateName: string;
  isRunning: boolean;
}

export default function WorkflowGraph({ templateName, isRunning }: WorkflowGraphProps) {
  const { progress } = useJobs();
  const statusMap = useNodeStatusMap(templateName);

  const [workflowJson, setWorkflowJson] = useState<WorkflowJson | null>(null);
  const [mainNodeIds, setMainNodeIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch workflow JSON + template bundle (widgets list) in parallel. The
  // widgets list gives us the exact set of "main" nodes Studio considers
  // user-facing (same data populating "advanced fields"). Filter graph to
  // these + terminal outputs so we don't render every plumbing intermediate.
  useEffect(() => {
    if (!templateName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWorkflowJson(null);
    setMainNodeIds(null);

    Promise.all([
      api.getTemplateApiPrompt(templateName),
      api.getTemplateBundle(templateName).catch(() => null),
    ])
      .then(([promptRes, bundleRes]) => {
        if (cancelled) return;
        setWorkflowJson(promptRes.apiPrompt as WorkflowJson);
        if (bundleRes) {
          const ids = new Set<string>();
          for (const w of bundleRes.widgets) {
            if (w.nodeId) ids.add(w.nodeId);
          }
          setMainNodeIds(ids);
        } else {
          setMainNodeIds(new Set());
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load workflow');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [templateName]);

  // Parse and layout — nodes themselves carry their category for tinting.
  const { initialNodes, initialEdges } = useMemo(() => {
    if (!workflowJson) return { initialNodes: [], initialEdges: [] };
    const { rfNodes, rfEdges } = parseWorkflow(workflowJson, mainNodeIds);
    const laid = layoutGraph(rfNodes, rfEdges);
    return { initialNodes: laid, initialEdges: rfEdges };
  }, [workflowJson, mainNodeIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Re-initialise graph when workflow changes
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Update node statuses from statusMap + progress.
  useEffect(() => {
    if (!workflowJson) return;
    setNodes(nds =>
      nds.map(node => {
        const st = statusMap.get(node.id) ?? 'pending';
        const isNodeRunning = st === 'running';
        return {
          ...node,
          data: {
            ...node.data,
            status: st,
            progressValue: isNodeRunning ? (progress?.value ?? 0) : undefined,
            progressMax: isNodeRunning ? (progress?.max ?? 0) : undefined,
          },
        };
      })
    );
  }, [statusMap, progress, workflowJson, setNodes]);

  // Update edge colors when a node is running (highlight incoming edges)
  useEffect(() => {
    if (!isRunning) {
      setEdges(eds =>
        eds.map(e => ({
          ...e,
          style: { stroke: 'var(--color-border, #e2e8f0)', strokeWidth: 1.5 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 10,
            height: 10,
            color: 'var(--color-border, #e2e8f0)',
          },
        }))
      );
      return;
    }

    const runningNodeId = progress?.nodeId;
    setEdges(eds =>
      eds.map(e => {
        const isActive = runningNodeId && e.target === runningNodeId;
        const strokeColor = isActive
          ? 'var(--color-success, #22c55e)'
          : 'var(--color-border, #e2e8f0)';
        return {
          ...e,
          style: { stroke: strokeColor, strokeWidth: isActive ? 2 : 1.5 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 10,
            height: 10,
            color: strokeColor,
          },
          animated: isActive,
        };
      })
    );
  }, [progress?.nodeId, isRunning, setEdges]);

  const onInit = useCallback((instance: { fitView: () => void }) => {
    setTimeout(() => instance.fitView(), 0);
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground gap-2">
        <span className="w-4 h-4 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        Loading workflow graph…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Could not load workflow graph
      </div>
    );
  }

  if (nodes.length === 0) {
    return null;
  }

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onInit={onInit}
        fitView
        fitViewOptions={{ padding: 0.1, maxZoom: 1.1 }}
        minZoom={0.2}
        maxZoom={2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll
        panOnDrag
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} color="var(--color-border, #e2e8f0)" />
        <Controls
          showInteractive={false}
          className="!bg-card !border !border-border !shadow-sm"
        />
      </ReactFlow>
    </>
  );
}
