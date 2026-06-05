// GET /api/jobs/:id         — poll status of a ComfyUI generation job
// GET /api/jobs/:id/events  — SSE stream of live events for a job

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute, registerSpecOnly } from '../lib/defineRoute.js';
import { NotFoundError } from '../lib/errors.js';
import { openSseStream } from '../lib/sse.js';
import { defineSseRouteSpec } from '../contracts/sse.contract.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  JobStatusSchema,
  JobEventStatusSchema,
  JobEventProgressSchema,
  JobEventDoneSchema,
  JobEventErrorSchema,
} from '../contracts/jobs.contract.js';
import { getJobStatus } from '../services/jobs/status.js';
import * as eventBus from '../services/jobs/eventBus.js';
import type { JobEvent } from '../services/jobs/eventBus.js';

// SSE spec — all possible events this stream can emit.
const jobEventsSseSpec = defineSseRouteSpec({
  events: {
    status: JobEventStatusSchema,
    progress: JobEventProgressSchema,
    done: JobEventDoneSchema,
    error: JobEventErrorSchema,
  },
  terminalEvents: ['done', 'error'],
});

// ---- GET /api/jobs/:id -------------------------------------------------------

const idParamsSchema = z.object({ id: z.string().min(1) });

export const getJobStatusRoute = defineRoute({
  method: 'GET',
  path: '/jobs/:id',
  params: idParamsSchema,
  response: JobStatusSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['jobs'],
  summary: 'Status of a ComfyUI generation job',
}, async ({ params, ok }) => {
  const status = await getJobStatus(params.id);
  if (status === null) throw new NotFoundError('Job not found');
  return ok(status);
});

// ---- GET /api/jobs/:id/events  (SSE — registered manually) ------------------

// Spec-only for OpenAPI emission; the raw route is registered below.
registerSpecOnly({
  method: 'GET',
  path: '/jobs/:id/events',
  params: idParamsSchema,
  response: JobEventStatusSchema,
  responseContentType: 'text/event-stream',
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['jobs'],
  summary: 'SSE stream of live events for a ComfyUI generation job',
});

// Normalize a bus JobEvent to a typed SSE emit call.
async function dispatchBusEvent(
  stream: ReturnType<typeof openSseStream<typeof jobEventsSseSpec['events']>>,
  event: JobEvent,
  jobId: string,
  now: number,
): Promise<void> {
  if (stream.closed) return;
  switch (event.type) {
    case 'status':
      await stream.emit('status', {
        id: jobId,
        status: 'running',
        createdAt: now,
        updatedAt: event.ts,
      });
      break;
    case 'progress': {
      const d = event.data as { node?: string; step?: number; total?: number };
      await stream.emit('progress', {
        node: d.node ?? '',
        step: d.step ?? 0,
        total: d.total ?? 0,
      });
      break;
    }
    case 'done': {
      await stream.emitTerminal('done', {
        status: 'success',
        items: [],
      });
      break;
    }
    case 'error': {
      const d = event.data as { code?: string; message?: string };
      await stream.emitTerminal('error', {
        code: d.code ?? 'error',
        message: d.message ?? 'Unknown error',
      });
      break;
    }
  }
}

export function registerJobsRouter(router: Router): void {
  // Register the poll route.
  getJobStatusRoute.register(router);

  // Register the SSE route.
  router.get(
    '/jobs/:id/events',
    authMiddleware({ required: true, scopes: ['generate:write'] }),
    async (req, res): Promise<void> => {
      const rawId = req.params['id'];
      const jobId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!jobId) {
        res.status(400).json({ error: { code: 'validation_failed', message: 'Missing job id' } });
        return;
      }

      const now = Date.now();

      // Fetch current status to send as the initial event.
      const currentStatus = await getJobStatus(jobId).catch(() => null);

      let unsub: (() => void) | null = null;
      const stream = openSseStream(req, res, jobEventsSseSpec, {
        onClose: () => { unsub?.(); },
      });

      // Parse Last-Event-ID for replay support.
      const lastEventIdHeader = req.headers['last-event-id'];
      const lastSeq = typeof lastEventIdHeader === 'string'
        ? (parseInt(lastEventIdHeader, 10) || -1)
        : -1;

      // Replay any buffered events after the last-seen seq before subscribing.
      const replayEvents = eventBus.replay(jobId, lastSeq);
      for (const evt of replayEvents) {
        if (stream.closed) return;
        await dispatchBusEvent(stream, evt, jobId, now);
        if (stream.closed) return;
      }

      // If already terminal after replay, stream closed itself — nothing more to do.
      if (stream.closed) return;

      // Send current status snapshot so client always sees a baseline.
      if (currentStatus && !stream.closed) {
        await stream.emit('status', {
          id: jobId,
          status: currentStatus.status,
          createdAt: currentStatus.createdAt,
          updatedAt: currentStatus.updatedAt,
        });
      }

      // If already terminal (from status read) and no bus events are coming, close.
      if (
        currentStatus &&
        (currentStatus.status === 'success' || currentStatus.status === 'failed' || currentStatus.status === 'cancelled') &&
        !stream.closed
      ) {
        if (currentStatus.status === 'success') {
          await stream.emitTerminal('done', {
            status: 'success',
            items: currentStatus.result?.items ?? [],
          });
        } else {
          await stream.emitTerminal('error', {
            code: currentStatus.status,
            message: currentStatus.error?.message ?? 'Job ended',
          });
        }
        return;
      }

      // Subscribe to live events from the bus.
      unsub = eventBus.subscribe(jobId, (evt) => {
        void dispatchBusEvent(stream, evt, jobId, now);
      });
    },
  );
}

const router = Router();
registerJobsRouter(router);
export default router;
