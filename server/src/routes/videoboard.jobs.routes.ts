// Videoboard — job routes + per-job SSE stream.
// GET /api/videoboard/jobs/:id         — poll a job record
// GET /api/videoboard/jobs/:id/stream  — SSE stream of live job progress

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as repo from '../lib/db/videoboard.repo.js';
import { openSseStream } from '../lib/sse.js';
import { defineSseRouteSpec } from '../contracts/sse.contract.js';
import { JobRecordSchema } from '../contracts/videoboard.js';

// ---- SSE spec ----------------------------------------------------------------

const jobSseSpec = defineSseRouteSpec({
  events: {
    /** Intermediate progress tick. */
    progress: z.object({
      jobId: z.string(),
      status: z.enum(['queued', 'running', 'done', 'error']),
      progress: z.number().min(0).max(1),
      message: z.string().optional(),
    }),
    /** Job completed successfully. */
    result: z.object({
      jobId: z.string(),
      status: z.literal('done'),
      progress: z.number(),
      outputUrl: z.string().optional(),
      message: z.string().optional(),
    }),
    /** Job failed. */
    error: z.object({
      jobId: z.string(),
      status: z.literal('error'),
      message: z.string(),
    }),
    /** Stream closed after terminal event. */
    done: z.object({ jobId: z.string() }),
  },
  terminalEvents: ['result', 'error', 'done'],
});

// ---- Poll route (defineRoute) ------------------------------------------------

export const getJobRoute = defineRoute({
  method: 'GET',
  path: '/videoboard/jobs/:id',
  params: z.object({ id: z.string() }),
  response: JobRecordSchema,
  auth: { required: true, scopes: ['videoboard:read'] },
  tags: ['videoboard'],
  summary: 'Get job record by id',
}, (ctx) => {
  const job = repo.getJob(ctx.params.id);
  if (!job) throw new NotFoundError('Job not found');
  return ctx.ok(job);
});

// ---- SSE stream (registered manually — needs raw req/res) -------------------

/** WS broadcaster set by the parent router so we can tap the same bus. */
let _onJobUpdate: ((jobId: string, cb: (job: import('../contracts/videoboard.js').JobRecord) => void) => (() => void)) | null = null;

/**
 * Wire the per-job subscription factory. Called from videoboard.routes.ts
 * AFTER the WS broadcaster is ready. The factory must:
 *   - immediately fire `cb` with the current job state (if it exists)
 *   - register `cb` on the WS bus and return an unsubscribe fn
 */
export function setJobUpdateSubscriber(
  fn: (jobId: string, cb: (job: import('../contracts/videoboard.js').JobRecord) => void) => (() => void),
): void {
  _onJobUpdate = fn;
}

export function registerJobStreamRoute(router: Router): void {
  // GET /api/videoboard/jobs/:id/stream
  router.get('/videoboard/jobs/:id/stream', async (req, res, next): Promise<void> => {
    const jobId = req.params.id as string;
    if (!jobId) { next(new ValidationError('Missing job id')); return; }

    const job = repo.getJob(jobId);
    if (!job) { next(new NotFoundError('Job not found')); return; }

    // If job is already terminal, emit the terminal event immediately and close.
    if (job.status === 'done' || job.status === 'error') {
      const stream = openSseStream(req, res, jobSseSpec);
      if (job.status === 'done') {
        await stream.emitTerminal('result', { jobId, status: 'done', progress: job.progress, outputUrl: job.outputUrl, message: job.message });
      } else {
        await stream.emitTerminal('error', { jobId, status: 'error', message: job.message ?? 'Job failed' });
      }
      return;
    }

    let unsub: (() => void) | null = null;
    const stream = openSseStream(req, res, jobSseSpec, {
      onClose: () => { if (unsub) unsub(); },
    });

    // Emit current state immediately so client sees where we are.
    await stream.emit('progress', {
      jobId,
      status: job.status,
      progress: job.progress,
      message: job.message,
    });

    if (!_onJobUpdate) {
      // No subscriber wired yet — fall back to polling the DB every 2s.
      const timer = setInterval(async () => {
        if (stream.closed) { clearInterval(timer); return; }
        const current = repo.getJob(jobId);
        if (!current) { clearInterval(timer); stream.close(); return; }
        if (current.status === 'done') {
          clearInterval(timer);
          await stream.emitTerminal('result', { jobId, status: 'done', progress: current.progress, outputUrl: current.outputUrl, message: current.message });
        } else if (current.status === 'error') {
          clearInterval(timer);
          await stream.emitTerminal('error', { jobId, status: 'error', message: current.message ?? 'Job failed' });
        } else {
          await stream.emit('progress', { jobId, status: current.status, progress: current.progress, message: current.message });
        }
      }, 2000);
      unsub = () => clearInterval(timer);
      return;
    }

    // Real subscription path — driven by WS bus pushes.
    unsub = _onJobUpdate(jobId, async (updatedJob) => {
      if (stream.closed) return;
      if (updatedJob.status === 'done') {
        await stream.emitTerminal('result', { jobId, status: 'done', progress: updatedJob.progress, outputUrl: updatedJob.outputUrl, message: updatedJob.message });
      } else if (updatedJob.status === 'error') {
        await stream.emitTerminal('error', { jobId, status: 'error', message: updatedJob.message ?? 'Job failed' });
      } else {
        await stream.emit('progress', { jobId, status: updatedJob.status, progress: updatedJob.progress, message: updatedJob.message });
      }
    });
  });
}
