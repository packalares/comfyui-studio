import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { GenerationJob, QueueStatus, DownloadState } from '../types';
import { api, ApiError } from '../services/comfyui';
import { toast } from 'sonner';

/**
 * Live progress shape for the currently-executing prompt. `nodeId` comes
 * from ComfyUI's `progress` WS message (the node currently running),
 * `promptId` is the id our relay attaches or we derive from `activePromptId`.
 */
export interface LiveProgress {
  nodeId: string;
  value: number;
  max: number;
  promptId: string | null;
}

/** Per-node ComfyUI execution state (sourced from `progress_state` WS event,
 *  plus incremental updates from `executing` / `executed`). Lets the Studio
 *  workflow graph mark every node as it transitions — not just the slow
 *  ones that emit sub-step `progress` events. Bounded to the current prompt;
 *  reset on `execution_start` and `execution_success`. */
export type ComfyNodeRunState = 'pending' | 'running' | 'finished';

export interface JobsContextType {
  currentJob: GenerationJob | null;
  queueStatus: QueueStatus;
  downloads: Record<string, DownloadState>;
  progress: LiveProgress | null;
  /** Per-node state map for the active prompt, or null when no prompt running. */
  nodeStates: Record<string, ComfyNodeRunState> | null;
  activePromptId: string | null;
  /** ComfyUI node ids that caused the last failure (validation or runtime). */
  errorNodeIds: string[];
  /** Per-node "required input is missing" details from the last validation
   *  failure — lets the UI trace the missing input back to its upstream
   *  (form-bound) provider node, e.g. a LoadImage feeding a resize node. */
  errorEdges: Array<{ nodeId: string; missingInput: string }>;
  submitGeneration: (
    templateName: string,
    inputs: Record<string, unknown>,
    advancedSettings?: Record<string, { proxyIndex: number; value: unknown }>,
  ) => Promise<void>;
  cancelRunning: () => Promise<void>;
  cancelPending: (promptId: string) => Promise<void>;
  setCurrentJob: React.Dispatch<React.SetStateAction<GenerationJob | null>>;
  // Internal setters/refs exposed to sibling providers (Ws).
  _setQueueStatus: React.Dispatch<React.SetStateAction<QueueStatus>>;
  _setDownloads: React.Dispatch<React.SetStateAction<Record<string, DownloadState>>>;
  _setProgress: React.Dispatch<React.SetStateAction<LiveProgress | null>>;
  _setNodeStates: React.Dispatch<React.SetStateAction<Record<string, ComfyNodeRunState> | null>>;
  _setActivePromptId: React.Dispatch<React.SetStateAction<string | null>>;
  _setErrorNodeIds: React.Dispatch<React.SetStateAction<string[]>>;
  _activePromptIdRef: React.MutableRefObject<string | null>;
  _outputFetchedRef: React.MutableRefObject<boolean>;
  _outputFetchInFlightRef: React.MutableRefObject<boolean>;
  _fetchOutputFromHistory: (promptId: string) => void;
}

const JobsContext = createContext<JobsContextType | null>(null);

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [currentJob, setCurrentJob] = useState<GenerationJob | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({ queue_running: 0, queue_pending: 0 });
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [progress, setProgress] = useState<LiveProgress | null>(null);
  const [nodeStates, setNodeStates] = useState<Record<string, ComfyNodeRunState> | null>(null);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [errorNodeIds, setErrorNodeIds] = useState<string[]>([]);
  const [errorEdges, setErrorEdges] = useState<Array<{ nodeId: string; missingInput: string }>>([]);

  const activePromptIdRef = useRef<string | null>(null);
  const outputFetchedRef = useRef(false);
  const outputFetchInFlightRef = useRef(false);

  // Keep the ref in sync with state — state can be updated from WS events
  // in AppContext (not just from submitGeneration), and WS handlers read
  // the ref synchronously. Without this sync, a page refresh mid-run or
  // a prompt originating from another tab would leave the ref stale/null.
  useEffect(() => {
    activePromptIdRef.current = activePromptId;
  }, [activePromptId]);

  const fetchOutputFromHistory = useCallback((promptId: string) => {
    // Skip if already resolved or a fetch is already racing for this prompt.
    // (Multiple WS events fire for one completion — without this we'd issue 4+ parallel /api/history calls.)
    if (outputFetchedRef.current || outputFetchInFlightRef.current) return;
    outputFetchInFlightRef.current = true;
    fetch(`/api/history/${promptId}`)
      .then(r => r.json())
      .then(data => {
        if (outputFetchedRef.current) return;
        // Cache-hit orphan: ComfyUI served this from cache but the source
        // gallery row was deleted, so the result is unreachable. Fail
        // loudly so the user knows to regenerate.
        if (data.cacheOrphaned) {
          outputFetchedRef.current = true;
          const reason = typeof data.reason === 'string'
            ? data.reason
            : 'Cached result unavailable.';
          toast.error('Result unavailable', { description: reason });
          setCurrentJob(p => p ? { ...p, status: 'failed', error: reason } : p);
          return;
        }
        if (data.outputs?.length > 0) {
          outputFetchedRef.current = true;
          const out = data.outputs[0];
          const url = `/api/view?filename=${encodeURIComponent(out.filename)}&subfolder=${encodeURIComponent(out.subfolder || '')}&type=${encodeURIComponent(out.type || 'output')}`;
          setCurrentJob(p => {
            if (!p) return p;
            return { ...p, status: 'completed', progress: 100, outputUrl: url, outputMediaType: out.mediaType, completedAt: new Date().toISOString() };
          });
          // Gallery & queue updates arrive via the backend's WS broadcasts; no REST refresh needed.
        } else {
          // The prompt is done (a terminal WS signal triggered this fetch) but
          // produced no recognized output — or history just hasn't been written
          // yet. Terminate the job anyway so the UI (Generate button, graph,
          // queue label) doesn't hang on 'running'. Deliberately NOT setting
          // `outputFetchedRef`: a later trigger may still find an output, and
          // the branch above re-applies the URL on top of the completed status.
          setCurrentJob(p => (p && p.status === 'running' ? { ...p, status: 'completed', progress: 100, completedAt: new Date().toISOString() } : p));
        }
      })
      .catch(() => {
        // Couldn't read history, but the prompt finished — terminate the job
        // (without an output URL) rather than leave it stuck on 'running'.
        setCurrentJob(p => (p && p.status === 'running' ? { ...p, status: 'completed', completedAt: new Date().toISOString() } : p));
      })
      .finally(() => { outputFetchInFlightRef.current = false; });
  }, []);

  const submitGeneration = useCallback(
    async (
      templateName: string,
      inputs: Record<string, unknown>,
      advancedSettings?: Record<string, { proxyIndex: number; value: unknown }>,
    ) => {
      outputFetchedRef.current = false;
      setErrorNodeIds([]);
      setErrorEdges([]);
      const job: GenerationJob = {
        id: crypto.randomUUID(),
        templateName,
        status: 'pending',
        progress: 0,
        inputs,
        createdAt: new Date().toISOString(),
      };
      setCurrentJob(job);
      try {
        const result = await api.generate(templateName, inputs, advancedSettings);
        const promptId = result.prompt_id || job.id;
        activePromptIdRef.current = promptId;
        setActivePromptId(promptId);
        setCurrentJob(prev => prev ? { ...prev, status: 'running', id: promptId } : null);
      } catch (err) {
        // Surface structured ComfyUI validation failures. Server wraps them as
        // { error, nodeErrors: [{nodeId, classType, message, details}] }.
        // Group by (classType, message) so identical failures across many
        // nodes collapse into one line ("LoadImage: Custom validation failed
        // (nodes 12, 13, 14, 15)") instead of repeating.
        let title = 'Generation failed';
        let description: React.ReactNode | undefined;
        if (err instanceof ApiError) {
          title = err.message || title;
          const data = err.data as {
            nodeErrors?: Array<{ nodeId: string; classType?: string; message: string; details?: string }>;
            detail?: string;
          } | null;
          if (data?.nodeErrors && data.nodeErrors.length > 0) {
            // Surface failing node ids so the graph and form fields can highlight them.
            setErrorNodeIds(data.nodeErrors.map(n => n.nodeId));
            // `details` on a "required input is missing" error is the missing
            // input's name — keep it so the UI can trace it to the provider.
            setErrorEdges(
              data.nodeErrors
                .filter(n => typeof n.details === 'string' && n.details.length > 0 && /required input is missing/i.test(n.message))
                .map(n => ({ nodeId: n.nodeId, missingInput: n.details as string })),
            );
            const groups = new Map<string, { classType?: string; message: string; nodeIds: string[] }>();
            for (const n of data.nodeErrors) {
              const key = `${n.classType ?? ''}|${n.message}`;
              const existing = groups.get(key);
              if (existing) existing.nodeIds.push(n.nodeId);
              else groups.set(key, { classType: n.classType, message: n.message, nodeIds: [n.nodeId] });
            }
            const rows = Array.from(groups.values()).slice(0, 6);
            description = (
              <ul className="list-disc pl-4 space-y-1 text-[12px]">
                {rows.map((g, i) => (
                  <li key={i}>
                    {g.classType && <span className="font-medium">{g.classType}</span>}
                    {g.classType && ': '}
                    <span>{g.message}</span>
                    {g.nodeIds.length > 0 && (
                      <span className="text-muted-foreground">
                        {' '}({g.nodeIds.length === 1 ? `node ${g.nodeIds[0]}` : `nodes ${g.nodeIds.join(', ')}`})
                      </span>
                    )}
                  </li>
                ))}
                {groups.size > rows.length && (
                  <li className="text-muted-foreground list-none">…and {groups.size - rows.length} more</li>
                )}
              </ul>
            );
          } else if (typeof data?.detail === 'string') {
            description = data.detail;
          }
        } else if (err instanceof Error) {
          description = err.message;
        }
        toast.error(title, description ? { description } : undefined);
        setCurrentJob(prev => prev ? { ...prev, status: 'failed', error: title } : null);
        console.error('Generation failed:', err);
      }
    },
    [],
  );

  const cancelRunning = useCallback(async () => {
    try {
      await api.interruptExecution();
      toast.success('Stopped current prompt');
    } catch (err) {
      toast.error('Failed to stop prompt', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const cancelPending = useCallback(async (promptId: string) => {
    try {
      await api.cancelQueuedPrompt(promptId);
      toast.success('Removed from queue');
    } catch (err) {
      toast.error('Failed to cancel queued prompt', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  return (
    <JobsContext.Provider
      value={{
        currentJob,
        queueStatus,
        downloads,
        progress,
        nodeStates,
        activePromptId,
        errorNodeIds,
        errorEdges,
        submitGeneration,
        cancelRunning,
        cancelPending,
        setCurrentJob,
        _setQueueStatus: setQueueStatus,
        _setDownloads: setDownloads,
        _setProgress: setProgress,
        _setNodeStates: setNodeStates,
        _setActivePromptId: setActivePromptId,
        _setErrorNodeIds: setErrorNodeIds,
        _activePromptIdRef: activePromptIdRef,
        _outputFetchedRef: outputFetchedRef,
        _outputFetchInFlightRef: outputFetchInFlightRef,
        _fetchOutputFromHistory: fetchOutputFromHistory,
      }}
    >
      {children}
    </JobsContext.Provider>
  );
}

export function useJobs() {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error('useJobs must be used within JobsProvider');
  return ctx;
}
