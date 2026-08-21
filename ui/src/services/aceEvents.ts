// ACE-Step music page real-time events (generation / TTS / training).
//
// Typed event-emitter facade mirroring `videoboardEvents.ts` — none of these
// open their own WebSocket. `AppContext` (the single owner of the
// page-level `ws://.../ws` connection) detects `ace:generation` /
// `ace:tts` / `ace:training` messages in `ws.onmessage` and routes them
// here via the `dispatch*` functions below. `CreateTab`, `TtsTab`, and
// `TrainTab` subscribe via the exported hooks/functions.

import { useEffect, useRef } from 'react';
import type { GenerationStatusResponse, TtsStatus } from '../types/ace';

// ---------------------------------------------------------------------------
// Generation (Create tab)
// ---------------------------------------------------------------------------

type GenerationHandler = (status: GenerationStatusResponse) => void;
const generationSubs = new Set<GenerationHandler>();

// ---------------------------------------------------------------------------
// TTS (Tts tab)
// ---------------------------------------------------------------------------

type TtsHandler = (status: TtsStatus) => void;
const ttsSubs = new Set<TtsHandler>();

// ---------------------------------------------------------------------------
// Training (Train tab) — `kind` distinguishes ACE-Step's own FastAPI-backed
// preprocess/auto-label/train singleton state from the per-dataset whisper
// batch-transcription job.
// ---------------------------------------------------------------------------

export type AceTrainingEvent =
  | { kind: 'preprocess' | 'autoLabel' | 'train'; raw: Record<string, unknown> }
  | {
    kind: 'whisper';
    datasetName: string;
    status: 'running' | 'succeeded' | 'failed';
    dir: string;
    error?: string;
    lines: string[];
  };

type TrainingHandler = (event: AceTrainingEvent) => void;
const trainingSubs = new Set<TrainingHandler>();

export const aceEvents = {
  onGeneration: (h: GenerationHandler): (() => void) => {
    generationSubs.add(h);
    return () => { generationSubs.delete(h); };
  },
  dispatchGeneration: (status: GenerationStatusResponse): void => {
    generationSubs.forEach((h) => { h(status); });
  },

  onTts: (h: TtsHandler): (() => void) => {
    ttsSubs.add(h);
    return () => { ttsSubs.delete(h); };
  },
  dispatchTts: (status: TtsStatus): void => {
    ttsSubs.forEach((h) => { h(status); });
  },

  onTraining: (h: TrainingHandler): (() => void) => {
    trainingSubs.add(h);
    return () => { trainingSubs.delete(h); };
  },
  dispatchTraining: (event: AceTrainingEvent): void => {
    trainingSubs.forEach((h) => { h(event); });
  },
};

/** Subscribe to WS pushes for one generation `jobId`. Mirrors
 *  `usePackTaskEvents` — callers own the initial REST reconciliation fetch
 *  and any fallback polling. */
export function useGenerationEvents(jobId: string | null, onUpdate: GenerationHandler): void {
  const ref = useRef(onUpdate);
  ref.current = onUpdate;
  useEffect(() => {
    if (!jobId) return;
    return aceEvents.onGeneration((status) => {
      if (status.jobId === jobId) ref.current(status);
    });
  }, [jobId]);
}

/** Subscribe to WS pushes for one TTS `jobId`. */
export function useTtsEvents(jobId: string | null, onUpdate: TtsHandler): void {
  const ref = useRef(onUpdate);
  ref.current = onUpdate;
  useEffect(() => {
    if (!jobId) return;
    return aceEvents.onTts((status) => {
      if (status.id === jobId) ref.current(status);
    });
  }, [jobId]);
}
