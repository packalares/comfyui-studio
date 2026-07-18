// Voice-clone TTS (IndexTTS2) job tracker. Ported from ace-step-ui's
// `server/src/services/ttsJobs.ts`, which held an in-memory `Map` with a
// timed sweep. This is now a thin wrapper over
// `lib/db/aceTraining.repo.ts`'s `ace_tts_jobs` table — durable across
// restarts, no sweep needed (rows are cheap and small; add a TTL cleanup
// later if the table ever grows large enough to matter for a single-user app).
//
// Used by `routes/ace/tts.routes.ts`'s `POST /clone` + `GET /status/:jobId`.

import { randomUUID } from 'node:crypto';
import * as repo from '../../lib/db/aceTraining.repo.js';

export type TtsJobStatus = repo.TtsJobStatus;

export interface TtsJobResult {
  audioUrl: string;
  durationSeconds: number;
}

export type TtsJob = repo.TtsJobRow;

export function createJob(): TtsJob {
  return repo.createTtsJob(randomUUID());
}

export function getJob(id: string): TtsJob | undefined {
  return repo.getTtsJob(id) ?? undefined;
}

export interface TtsJobPatch {
  status?: TtsJobStatus;
  progress?: number;
  result?: TtsJobResult;
  error?: string;
  appendLog?: string;
}

export function updateJob(id: string, patch: TtsJobPatch): TtsJob | undefined {
  // `TtsJobResult` is a concrete interface (no index signature), so it isn't
  // structurally assignable to the repo's `Record<string, unknown>` — cast
  // at this thin boundary rather than widening the repo's type.
  return repo.updateTtsJob(id, patch as repo.TtsJobUpdateInput) ?? undefined;
}
