import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import type { GenerationJob, QueueStatus, DownloadState } from '../types';
import { api } from '../services/comfyui';
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

export interface JobsContextType {
  currentJob: GenerationJob | null;
  queueStatus: QueueStatus;
  downloads: Record<string, DownloadState>;
  progress: LiveProgress | null;
  activePromptId: string | null;
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
  _setActivePromptId: React.Dispatch<React.SetStateAction<string | null>>;
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
  const [activePromptId, setActivePromptId] = useState<string | null>(null);

  const activePromptIdRef = useRef<string | null>(null);
  const outputFetchedRef = useRef(false);
  const outputFetchInFlightRef = useRef(false);

  const fetchOutputFromHistory = useCallback((promptId: string) => {
    // Skip if already resolved or a fetch is already racing for this prompt.
    // (Multiple WS events fire for one completion — without this we'd issue 4+ parallel /api/history calls.)
    if (outputFetchedRef.current || outputFetchInFlightRef.current) return;
    outputFetchInFlightRef.current = true;
    fetch(`/api/history/${promptId}`)
      .then(r => r.json())
      .then(data => {
        if (data.outputs?.length > 0 && !outputFetchedRef.current) {
          outputFetchedRef.current = true;
          const out = data.outputs[0];
          const url = `/api/view?filename=${encodeURIComponent(out.filename)}&subfolder=${encodeURIComponent(out.subfolder || '')}&type=${encodeURIComponent(out.type || 'output')}`;
          setCurrentJob(p => {
            if (!p) return p;
            return { ...p, status: 'completed', progress: 100, outputUrl: url, outputMediaType: out.mediaType, completedAt: new Date().toISOString() };
          });
          // Gallery & queue updates arrive via the backend's WS broadcasts; no REST refresh needed.
        }
      })
      .catch(() => {})
      .finally(() => { outputFetchInFlightRef.current = false; });
  }, []);

  const submitGeneration = useCallback(
    async (
      templateName: string,
      inputs: Record<string, unknown>,
      advancedSettings?: Record<string, { proxyIndex: number; value: unknown }>,
    ) => {
      outputFetchedRef.current = false;
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
        setCurrentJob(prev => prev ? { ...prev, status: 'failed' } : null);
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
        activePromptId,
        submitGeneration,
        cancelRunning,
        cancelPending,
        setCurrentJob,
        _setQueueStatus: setQueueStatus,
        _setDownloads: setDownloads,
        _setProgress: setProgress,
        _setActivePromptId: setActivePromptId,
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
