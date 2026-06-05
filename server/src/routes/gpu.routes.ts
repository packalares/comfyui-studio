// GPU scheduler meta routes.
// GET  /api/gpu             — scheduler snapshot. Scope: system:read.
// DELETE /api/gpu/queue/:id — cancel a queued (not running) job. Scope: system:write.

import { Router } from 'express';
import { defineRoute } from '../lib/defineRoute.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { scheduler } from '../services/gpu/scheduler.js';
import {
  SchedulerSnapshotSchema,
  CancelJobParamsSchema,
  CancelJobOutputSchema,
} from '../contracts/gpu.contract.js';

const getGpuRoute = defineRoute(
  {
    method: 'GET',
    path: '/gpu',
    response: SchedulerSnapshotSchema,
    auth: { required: true, scopes: ['system:read'] },
    tags: ['gpu'],
    summary: 'Get GPU scheduler snapshot',
  },
  ({ ok }) => ok(scheduler.snapshot()),
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

const router = Router();
getGpuRoute.register(router);
cancelJobRoute.register(router);

export default router;
