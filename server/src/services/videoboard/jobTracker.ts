// Job lifecycle tracker for Videoboard async jobs.
// Creates / updates JobRecord rows in SQLite and broadcasts WS events after
// each transition. The WS broadcaster is wired at startup via
// `setVideoboardBroadcaster` (called from index.ts).

import { randomUUID } from 'node:crypto';
import type { JobRecord, JobKind } from '../../contracts/videoboard.js';
import * as repo from '../../lib/db/videoboard.repo.js';

let broadcaster: ((payload: object) => void) | null = null;

export function setVideoboardBroadcaster(fn: ((payload: object) => void) | null): void {
  broadcaster = fn;
}

function emit(payload: object): void {
  if (broadcaster) broadcaster(payload);
}

export function createJob(
  projectId: string,
  kind: JobKind,
  shotIdx?: number,
): JobRecord {
  const now = Date.now();
  const job: JobRecord = {
    id: randomUUID(),
    projectId,
    shotIdx,
    kind,
    status: 'queued',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  repo.upsertJob(job);
  emit({ type: 'videoboard:job', record: job });
  return job;
}

export function updateJob(
  id: string,
  patch: Partial<Pick<JobRecord, 'status' | 'progress' | 'message' | 'outputUrl'>>,
): JobRecord | null {
  const job = repo.getJob(id);
  if (!job) return null;
  const updated: JobRecord = {
    ...job,
    ...patch,
    updatedAt: Date.now(),
  };
  repo.upsertJob(updated);
  emit({ type: 'videoboard:job', record: updated });
  return updated;
}
