// GPU scheduler meta routes.
// GET    /api/gpu              — scheduler snapshot + ComfyUI mirror state. Scope: system:read.
// DELETE /api/gpu/queue/:id    — cancel a queued (not running) job.       Scope: system:write.
// DELETE /api/gpu/queue        — cancel every queued job.                  Scope: system:write.
// DELETE /api/gpu/active       — force-release the held active slot.       Scope: system:write.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { scheduler } from '../services/gpu/scheduler.js';
import { getComfyState } from '../services/comfyui/jobBridge.js';
import {
  SchedulerSnapshotSchema,
  CancelJobParamsSchema,
  CancelJobOutputSchema,
  ForceReleaseActiveOutputSchema,
} from '../contracts/gpu.contract.js';

const getGpuRoute = defineRoute(
  {
    method: 'GET',
    path: '/gpu',
    response: SchedulerSnapshotSchema,
    auth: { required: true, scopes: ['system:read'] },
    tags: ['gpu'],
    summary: 'Get GPU scheduler snapshot + ComfyUI mirror state',
  },
  ({ ok }) => ok({ ...scheduler.snapshot(), comfy: getComfyState() }),
);

const cancelJobRoute = defineRoute(
  {
    method: 'DELETE',
    path: '/gpu/queue/:id',
    params: CancelJobParamsSchema,
    response: CancelJobOutputSchema,
    auth: { required: true, scopes: ['system:write'] },
    tags: ['gpu'],
    summary: 'Cancel a queued GPU job',
  },
  ({ params, ok }) => {
    const result = scheduler.cancel(params.id);
    if (result === 'not_found') throw new NotFoundError('No queued job with that id');
    if (result === 'running') throw new ConflictError('Cannot cancel a running job');
    return ok({ cancelled: true, jobId: params.id });
  },
);

const cancelAllRoute = defineRoute(
  {
    method: 'DELETE',
    path: '/gpu/queue',
    response: z.object({ cancelled: z.number().int().nonnegative() }),
    auth: { required: true, scopes: ['system:write'] },
    tags: ['gpu'],
    summary: 'Cancel every queued (not running) GPU job',
  },
  ({ ok }) => {
    const snap = scheduler.snapshot();
    let cancelled = 0;
    for (const j of snap.queue) {
      if (scheduler.cancel(j.jobId) === 'cancelled') cancelled += 1;
    }
    return ok({ cancelled });
  },
);

// Escape hatch for the case where a run() handler hangs and the slot stays
// held (e.g. a missed terminal event from ComfyUI, an upstream that doesn't
// honour AbortSignal). The underlying handler is NOT cancelled — but the
// scheduler accepts and drains the next queued job. Safe to call when idle
// (returns released: false).
const forceReleaseRoute = defineRoute(
  {
    method: 'DELETE',
    path: '/gpu/active',
    response: ForceReleaseActiveOutputSchema,
    auth: { required: true, scopes: ['system:write'] },
    tags: ['gpu'],
    summary: 'Force-release the currently held GPU scheduler slot',
  },
  ({ ok }) => ok({ released: scheduler.forceReleaseActive() }),
);

const router = Router();
getGpuRoute.register(router);
cancelJobRoute.register(router);
cancelAllRoute.register(router);
forceReleaseRoute.register(router);

export default router;
