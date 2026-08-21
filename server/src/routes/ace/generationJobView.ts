// Wire-shaping for generation jobs: DB row -> `GenerationStatusResponseSchema`,
// the WS broadcast that accompanies every status transition, and the value
// coercion both depend on.
//
// Extracted from `generate.routes.ts` when tonight's additions pushed that file
// past the repo's 900-line cap (`tests/structure.test.ts`). These concerns form
// one unit — anything that changes a job's status also needs it broadcast and
// its stored result sanitized — so they move together rather than split by
// mechanism.

import { z } from 'zod';
import * as aceMusicRepo from '../../lib/db/aceMusic.repo.js';
import { broadcastAce } from '../../services/ace/broadcaster.js';
import {
  GenerationResultSchema,
  GenerationStatusResponseSchema,
} from '../../contracts/ace/generate.contract.js';

/**
 * ACE-Step reports unknown metadata as the STRING "N/A", not null.
 *
 * On a `text2music` job the 5Hz LM infers bpm/key/time-signature/duration and
 * they come back as real numbers. On `cover`/`repaint` the LM is skipped
 * entirely ("Skipping LM for task_type='cover' - using DiT directly"), so every
 * one of those fields is the literal string "N/A".
 *
 * `??` does not help: it only guards null/undefined, so "N/A" flowed straight
 * into `GenerationResultSchema` (`duration: z.number()`) and the response was
 * rejected client-side with "Response envelope failed schema validation" — even
 * though the audio had generated and saved perfectly well. These two coercions
 * turn any non-numeric / sentinel value back into `undefined` so the schema's
 * own optionality applies.
 */
export function numeric(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Same idea for the string fields: drop "N/A" (and blanks) so the UI shows
 *  nothing rather than the word "N/A" in a key/time-signature slot. */
export function text(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t || t.toUpperCase() === 'N/A') return undefined;
  return t;
}

/** Wire-shaped view of a generation job, matching `GenerationStatusResponseSchema`
 *  exactly — used both by the `GET /status/:jobId` route (the reconciliation
 *  path a client hits on mount / after a dropped socket) and by every WS
 *  broadcast below, so the two surfaces never drift apart. `live` overlays
 *  the in-flight progress/stage ACE-Step reports mid-run (the DB row itself
 *  has no such column — see `pollUntilTerminal`). */
export function toStatusView(
  job: aceMusicRepo.GenerationJobRow,
  live?: { progress?: number; stage?: string },
): z.infer<typeof GenerationStatusResponseSchema> {
  return {
    jobId: job.id,
    status: job.status,
    progress: live?.progress,
    stage: live?.stage,
    result: sanitizeResult(job.result),
    error: job.error,
  };
}

/**
 * Coerce a stored `result_json` into the shape `GenerationResultSchema`
 * declares, healing rows written before the "N/A" coercion existed.
 *
 * Jobs run as `cover`/`repaint` recorded `{"duration":"N/A","bpm":"N/A",...}`
 * because ACE-Step skips the LM for those task types and reports its metadata
 * as that sentinel string. Those rows are already on disk, so fixing only the
 * write path would leave every existing job permanently un-fetchable: the
 * client validates the response envelope and rejects a string where the schema
 * says `duration: z.number()`, surfacing as "Response envelope failed schema
 * validation" on a job whose audio generated perfectly well.
 *
 * Done on read rather than as a migration so it also covers anything ACE-Step
 * starts returning in this shape later.
 */
export function sanitizeResult(raw: unknown): z.infer<typeof GenerationResultSchema> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    audioUrls: Array.isArray(r.audioUrls) ? r.audioUrls.filter((u): u is string => typeof u === 'string') : [],
    duration: numeric(r.duration) ?? 0,
    bpm: numeric(r.bpm),
    keyScale: text(r.keyScale),
    timeSignature: text(r.timeSignature),
    status: typeof r.status === 'string' ? r.status : 'succeeded',
  };
}

export function broadcastJob(job: aceMusicRepo.GenerationJobRow, live?: { progress?: number; stage?: string }): void {
  broadcastAce('ace:generation', toStatusView(job, live));
}

/** Wraps `aceMusicRepo.updateGenerationJob` so every status transition also
 *  pushes a `{type:'ace:generation', data}` WS frame — `CreateTab` subscribes
 *  to that instead of polling. Module-level (not a per-request closure) so
 *  `cancelGenerationJob` — invoked from a *different* request — can reuse it. */
export function updateJobStatus(
  jobId: string,
  patch: aceMusicRepo.GenerationJobUpdateInput,
): aceMusicRepo.GenerationJobRow | null {
  const job = aceMusicRepo.updateGenerationJob(jobId, patch);
  if (job) broadcastJob(job);
  return job;
}
