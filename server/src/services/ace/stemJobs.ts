// Stem-extraction job tracker. Ported from ace-step-ui's
// `server/src/services/stemJobs.ts`, which held an in-memory `Map` (job
// state, including its log tail, evaporated on every process restart, and
// the route gave the client no way to recover a jobId once that happened).
// This is now a thin wrapper over `lib/db/aceTraining.repo.ts`'s
// `ace_stem_jobs` table — same call shape, durable storage.
//
// Used by `routes/ace/training.routes.ts`'s `POST /preprocess-stems` +
// `GET /preprocess-stems-status`.

import { randomUUID } from 'node:crypto';
import * as repo from '../../lib/db/aceTraining.repo.js';

export type StemJobStatus = repo.StemJobStatus;
export type StemJob = repo.StemJobRow;

export function createJob(total: number): StemJob {
  return repo.createStemJob(randomUUID(), total);
}

export function getJob(id: string): StemJob | undefined {
  return repo.getStemJob(id) ?? undefined;
}

export interface StemJobPatch {
  status?: StemJobStatus;
  progress?: number;
  current?: number;
  result?: Record<string, unknown>;
  error?: string;
  /** Appends one line to the job's log tail (trimmed to the last 200 lines). */
  appendLog?: string;
}

export function updateJob(id: string, patch: StemJobPatch): StemJob | undefined {
  return repo.updateStemJob(id, patch) ?? undefined;
}
