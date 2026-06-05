// Videoboard — render route (stub: TODO wire real ffmpeg composition).

import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError } from '../lib/errors.js';
import * as repo from '../lib/db/videoboard.repo.js';
import * as jobTracker from '../services/videoboard/jobTracker.js';
import { JobStartedSchema } from '../contracts/videoboard.js';

let _emit: ((p: object) => void) | null = null;
export function setRenderEmitter(fn: ((p: object) => void) | null): void { _emit = fn; }
function emit(p: object): void { if (_emit) _emit(p); }

export const renderProjectRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/render',
  params: z.object({ id: z.string() }),
  response: JobStartedSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Render final video (async stub)',
}, (ctx) => {
  const { id } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');

  repo.updateProject(id, { status: 'generating' });
  const job = jobTracker.createJob(id, 'render');

  // TODO: wire real ffmpeg composition.
  setTimeout(() => { jobTracker.updateJob(job.id, { status: 'running', progress: 0.5 }); }, 1000);
  setTimeout(() => {
    const outputUrl = '/placeholder-render.mp4';
    repo.updateProject(id, { status: 'ready' });
    jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl });
    const updated = repo.getProject(id);
    if (updated) emit({ type: 'videoboard:project:updated', project: updated });
  }, 3000);

  return ctx.ok({ jobId: job.id });
});
