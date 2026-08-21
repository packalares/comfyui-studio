// Voice-clone TTS (IndexTTS2) job tracker. Ported from ace-step-ui's
// `server/src/services/ttsJobs.ts`, which held an in-memory `Map` with a
// timed sweep. This is now a thin wrapper over
// `lib/db/aceTraining.repo.ts`'s `ace_tts_jobs` table — durable across
// restarts, no sweep needed (rows are cheap and small; add a TTL cleanup
// later if the table ever grows large enough to matter for a single-user app).
//
// Used by `routes/ace/tts.routes.ts`'s `POST /clone` + `GET /status/:jobId`.
//
// `updateJob` also broadcasts the job's wire-shaped status over WS
// (`{type:'ace:tts', data}`) so `TtsTab` gets push updates instead of
// polling `GET /status/:jobId` on a fixed interval — see
// `services/ace/broadcaster.ts`'s header comment for the wiring pattern.
// `toStatusView` is exported so `routes/ace/tts.routes.ts`'s `GET
// /status/:jobId` (the reconciliation path used on mount / after a dropped
// socket) maps the row to the exact same wire shape.

import { randomUUID } from 'node:crypto';
import * as repo from '../../lib/db/aceTraining.repo.js';
import { broadcastAce } from './broadcaster.js';

export type TtsJobStatus = repo.TtsJobStatus;

export interface TtsJobResult {
  audioUrl: string;
  durationSeconds: number;
}

export type TtsJob = repo.TtsJobRow;

export interface TtsStatusView {
  id: string;
  status: TtsJobStatus;
  progress: number;
  log: string[];
  result: TtsJobResult | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Map the DB row's loosely-typed `result` (a plain `Record<string,
 *  unknown> | null` — the repo doesn't validate its shape) to the wire
 *  contract's `TtsJobResult | null`. Shared by the status route and the WS
 *  broadcast so both surfaces always agree on shape. */
export function toStatusView(job: TtsJob): TtsStatusView {
  const result = job.result as { audioUrl?: unknown; durationSeconds?: unknown } | null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    log: job.log,
    result: result && typeof result.audioUrl === 'string' && typeof result.durationSeconds === 'number'
      ? { audioUrl: result.audioUrl, durationSeconds: result.durationSeconds }
      : null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function createJob(): TtsJob {
  const job = repo.createTtsJob(randomUUID());
  broadcastAce('ace:tts', toStatusView(job));
  return job;
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
  const job = repo.updateTtsJob(id, patch as repo.TtsJobUpdateInput) ?? undefined;
  if (job) broadcastAce('ace:tts', toStatusView(job));
  return job;
}
