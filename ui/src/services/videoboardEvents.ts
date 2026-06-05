// Videoboard real-time events.
//
// This module is a typed event emitter facade that mirrors `chatEvents.ts`.
// It does NOT open its own WebSocket — instead, AppContext (the single owner
// of the page-level ws://.../ws connection) detects `videoboard:*` message
// types in `ws.onmessage` and routes them here via the `dispatch*` functions.
//
// Subscribers use the `useVideoboardEvents(projectId, handlers)` React hook,
// which is a thin wrapper that registers on/off lifecycles and filters
// events by `projectId`. All callers across the videoboard tree share the
// same underlying socket — no per-component reconnect, no duplicate sockets.

import { useEffect, useRef } from 'react';
import type { JobRecord, Shot, Analysis, Project } from '../api/videoboard';

// ---------------------------------------------------------------------------
// Per-job SSE stream (external-client alternative to the global WS bus)
// ---------------------------------------------------------------------------

export type JobSseEvent =
  | { event: 'progress'; jobId: string; status: JobRecord['status']; progress: number; message?: string }
  | { event: 'result';   jobId: string; status: 'done'; progress: number; outputUrl?: string; message?: string }
  | { event: 'error';    jobId: string; status: 'error'; message: string }
  | { event: 'done';     jobId: string };

export interface JobSseHandlers {
  onProgress?: (e: Extract<JobSseEvent, { event: 'progress' }>) => void;
  onResult?: (e: Extract<JobSseEvent, { event: 'result' }>) => void;
  onError?: (e: Extract<JobSseEvent, { event: 'error' }>) => void;
  onDone?: () => void;
}

/**
 * Open an SSE stream for a single job and return a close handle.
 * Terminal events (`result`, `error`) close the stream automatically.
 */
export function openJobStream(jobId: string, handlers: JobSseHandlers): () => void {
  const es = new EventSource(`/api/videoboard/jobs/${jobId}/stream`);
  es.addEventListener('progress', (ev) => {
    try {
      const d = JSON.parse((ev as MessageEvent).data) as Extract<JobSseEvent, { event: 'progress' }>;
      handlers.onProgress?.(d);
    } catch { /* ignore malformed */ }
  });
  es.addEventListener('result', (ev) => {
    try {
      const d = JSON.parse((ev as MessageEvent).data) as Extract<JobSseEvent, { event: 'result' }>;
      handlers.onResult?.(d);
    } catch { /* ignore malformed */ }
    handlers.onDone?.();
    es.close();
  });
  es.addEventListener('error', (ev) => {
    try {
      const d = JSON.parse((ev as MessageEvent).data) as Extract<JobSseEvent, { event: 'error' }>;
      handlers.onError?.(d);
    } catch { /* ignore malformed */ }
    handlers.onDone?.();
    es.close();
  });
  es.addEventListener('done', () => { handlers.onDone?.(); es.close(); });
  return () => es.close();
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface VideoboardEventHandlers {
  onJob?: (rec: JobRecord) => void;
  onShotUpdated?: (shot: Shot) => void;
  onAnalysisUpdated?: (analysis: Analysis) => void;
  onProjectUpdated?: (project: Project) => void;
}

export interface VideoboardShotUpdatedPayload {
  projectId: string;
  shot: Shot;
}

export interface VideoboardAnalysisUpdatedPayload {
  projectId: string;
  analysis: Analysis;
}

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

type Handler<T> = (payload: T) => void;

interface Bus {
  job: Set<Handler<JobRecord>>;
  shotUpdated: Set<Handler<VideoboardShotUpdatedPayload>>;
  analysisUpdated: Set<Handler<VideoboardAnalysisUpdatedPayload>>;
  projectUpdated: Set<Handler<Project>>;
}

const bus: Bus = {
  job: new Set(),
  shotUpdated: new Set(),
  analysisUpdated: new Set(),
  projectUpdated: new Set(),
};

function subscribe<T>(set: Set<Handler<T>>, h: Handler<T>): () => void {
  set.add(h);
  return () => { set.delete(h); };
}

export const videoboardEvents = {
  onJob: (h: Handler<JobRecord>) => subscribe(bus.job, h),
  onShotUpdated: (h: Handler<VideoboardShotUpdatedPayload>) => subscribe(bus.shotUpdated, h),
  onAnalysisUpdated: (h: Handler<VideoboardAnalysisUpdatedPayload>) => subscribe(bus.analysisUpdated, h),
  onProjectUpdated: (h: Handler<Project>) => subscribe(bus.projectUpdated, h),

  dispatchJob: (r: JobRecord) => bus.job.forEach((h) => { h(r); }),
  dispatchShotUpdated: (p: VideoboardShotUpdatedPayload) => bus.shotUpdated.forEach((h) => { h(p); }),
  dispatchAnalysisUpdated: (p: VideoboardAnalysisUpdatedPayload) => bus.analysisUpdated.forEach((h) => { h(p); }),
  dispatchProjectUpdated: (p: Project) => bus.projectUpdated.forEach((h) => { h(p); }),
};

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function useVideoboardEvents(
  projectId: string,
  handlers: VideoboardEventHandlers,
): void {
  // Stable handlers ref so subscribers see the latest callbacks without
  // having to re-subscribe on every parent render.
  const handlersRef = useRef<VideoboardEventHandlers>(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!projectId) return;
    const unsubs = [
      videoboardEvents.onJob((rec) => {
        if (rec.projectId === projectId) handlersRef.current.onJob?.(rec);
      }),
      videoboardEvents.onShotUpdated(({ projectId: pid, shot }) => {
        if (pid === projectId) handlersRef.current.onShotUpdated?.(shot);
      }),
      videoboardEvents.onAnalysisUpdated(({ projectId: pid, analysis }) => {
        if (pid === projectId) handlersRef.current.onAnalysisUpdated?.(analysis);
      }),
      videoboardEvents.onProjectUpdated((project) => {
        if (project.id === projectId) handlersRef.current.onProjectUpdated?.(project);
      }),
    ];
    return () => { unsubs.forEach((u) => u()); };
  }, [projectId]);
}
