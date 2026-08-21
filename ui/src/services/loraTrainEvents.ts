// AI-Toolkit image-LoRA training events (loraTrain/JobsPanel.tsx).
//
// Typed event-emitter facade mirroring `videoboardEvents.ts` — does not open
// its own WebSocket. `AppContext` detects `lora:training` (a fresh job row)
// and `lora:training:log` (one new log line) messages in `ws.onmessage` and
// routes them here.

import { useEffect, useRef } from 'react';
import type { AiToolkitJob } from './aiToolkit';

type JobHandler = (job: AiToolkitJob) => void;
const jobSubs = new Set<JobHandler>();

export interface LoraTrainingLogEvent {
  jobId: string;
  line: string;
}

type LogHandler = (event: LoraTrainingLogEvent) => void;
const logSubs = new Set<LogHandler>();

export const loraTrainEvents = {
  onJob: (h: JobHandler): (() => void) => {
    jobSubs.add(h);
    return () => { jobSubs.delete(h); };
  },
  dispatchJob: (job: AiToolkitJob): void => {
    jobSubs.forEach((h) => { h(job); });
  },

  onLog: (h: LogHandler): (() => void) => {
    logSubs.add(h);
    return () => { logSubs.delete(h); };
  },
  dispatchLog: (event: LoraTrainingLogEvent): void => {
    logSubs.forEach((h) => { h(event); });
  },
};

/** Subscribe to every job-row push — used to keep `JobsPanel`'s job list
 *  live without polling `GET /ai-toolkit/jobs` on an interval. */
export function useLoraTrainingJobs(onJob: JobHandler): void {
  const ref = useRef(onJob);
  ref.current = onJob;
  useEffect(() => loraTrainEvents.onJob((job) => ref.current(job)), []);
}

/** Subscribe to new log lines for one job. */
export function useLoraTrainingLog(jobId: string | null, onLine: (line: string) => void): void {
  const ref = useRef(onLine);
  ref.current = onLine;
  useEffect(() => {
    if (!jobId) return;
    return loraTrainEvents.onLog((event) => {
      if (event.jobId === jobId) ref.current(event.line);
    });
  }, [jobId]);
}
