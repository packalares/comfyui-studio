import { useEffect, useMemo, useRef, useState } from 'react';
import { useJobs } from '../../context/JobsContext';

export type NodeStatus = 'pending' | 'running' | 'done';

/**
 * Tracks per-node execution status by listening to JobsContext.
 *
 * Primary source: `nodeStates` (populated from ComfyUI's `progress_state`,
 * `executing`, and `executed` WS events — covers every node, not just the
 * ones that emit sub-step `progress`). Maps `finished` → `done` for our
 * graph palette.
 *
 * Fallback (older ComfyUI versions or workflows that don't emit `progress_state`):
 * the legacy inference from `progress.nodeId` transitions, which only sees
 * "slow" nodes like KSampler. Drops in cleanly when nodeStates is empty.
 *
 * Map is reset when `templateName` changes or a new job starts.
 */
export function useNodeStatusMap(templateName: string | null) {
  const { progress, nodeStates, currentJob } = useJobs();
  const [legacyMap, setLegacyMap] = useState<Map<string, NodeStatus>>(new Map());
  const prevNodeIdRef = useRef<string | null>(null);
  const prevTemplateRef = useRef<string | null>(null);

  // Reset legacy map on template change
  useEffect(() => {
    if (prevTemplateRef.current !== templateName) {
      prevTemplateRef.current = templateName;
      prevNodeIdRef.current = null;
      setLegacyMap(new Map());
    }
  }, [templateName]);

  // Reset legacy map on new-job start
  useEffect(() => {
    if (currentJob?.status === 'pending') {
      prevNodeIdRef.current = null;
      setLegacyMap(new Map());
    }
  }, [currentJob?.status]);

  // Legacy fallback: infer transitions from progress.nodeId changes.
  useEffect(() => {
    if (!progress) return;
    const { nodeId } = progress;
    setLegacyMap(prev => {
      const next = new Map(prev);
      const prevNodeId = prevNodeIdRef.current;
      if (prevNodeId && prevNodeId !== nodeId) next.set(prevNodeId, 'done');
      next.set(nodeId, 'running');
      prevNodeIdRef.current = nodeId;
      return next;
    });
  }, [progress?.nodeId, progress?.value]);

  // Final flip on completion — mark all visited nodes as done.
  useEffect(() => {
    if (currentJob?.status === 'completed') {
      setLegacyMap(prev => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        for (const [id] of next) next.set(id, 'done');
        return next;
      });
    }
  }, [currentJob?.status]);

  // Final view: prefer authoritative nodeStates when present, else legacy.
  // Both shapes are flattened to the same Map<string, NodeStatus> output.
  return useMemo<Map<string, NodeStatus>>(() => {
    if (nodeStates && Object.keys(nodeStates).length > 0) {
      const m = new Map<string, NodeStatus>();
      for (const [id, st] of Object.entries(nodeStates)) {
        m.set(id, st === 'finished' ? 'done' : st === 'running' ? 'running' : 'pending');
      }
      return m;
    }
    return legacyMap;
  }, [nodeStates, legacyMap]);
}
