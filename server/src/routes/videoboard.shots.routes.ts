// Videoboard — shot-level routes.
// Handles: update shot, generate image/video/chain, generate-all batches.

import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError, ConflictError } from '../lib/errors.js';
import * as repo from '../lib/db/videoboard.repo.js';
import * as jobTracker from '../services/videoboard/jobTracker.js';
import { runShotImageGen, isInflight } from '../services/videoboard/runShotImageGen.js';
import { runShotVideoGen, isVideoInflight } from '../services/videoboard/runShotVideoGen.js';
import {
  runShotVideoChainGen,
  isVideoChainInflight,
} from '../services/videoboard/runShotVideoChainGen.js';
import {
  ComfyJobCancelledError,
  ComfyJobExecutionError,
} from '../services/videoboard/comfyJobBridge.js';
import {
  ShotSchema,
  JobStartedSchema,
  GenerateAllResponseSchema,
  ChainStartedSchema,
  UpdateShotBodySchema,
  GenerateImageBodySchema,
  GenerateAllImagesBodySchema,
  AnimateShotBodySchema,
  GenerateAllVideosBodySchema,
  GenerateChainBodySchema,
} from '../contracts/videoboard.js';
import { viewUrlPointsToExistingFile } from './videoboard.shared.js';

// ---- Broadcast accessor ------------------------------------------------------

let _emit: ((p: object) => void) | null = null;
export function setShotsEmitter(fn: ((p: object) => void) | null): void { _emit = fn; }
function emit(p: object): void { if (_emit) _emit(p); }

// ---- Param schemas -----------------------------------------------------------

const IdxParams = z.object({ id: z.string(), idx: z.coerce.number().int().nonnegative() });
const IdParams = z.object({ id: z.string() });

// ---- Routes ------------------------------------------------------------------

export const updateShotRoute = defineRoute({
  method: 'PUT',
  path: '/videoboard/projects/:id/shots/:idx',
  params: IdxParams,
  body: UpdateShotBodySchema,
  response: ShotSchema,
  auth: { required: true, scopes: ['videoboard:write'] },
  tags: ['videoboard'],
  summary: 'Update a shot',
}, (ctx) => {
  const { id, idx } = ctx.params;
  const updated = repo.updateShot(id, idx, ctx.body);
  if (!updated) throw new NotFoundError('Shot not found');
  emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
  return ctx.ok(updated);
});

export const generateShotImageRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/shots/:idx/image',
  params: IdxParams,
  body: GenerateImageBodySchema,
  response: JobStartedSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Generate still image for a shot (async)',
}, (ctx) => {
  const { id, idx } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');
  const shot = repo.getShot(id, idx);
  if (!shot) throw new NotFoundError('Shot not found');

  const templateNameOverride = ctx.body.templateName ?? undefined;
  repo.updateShot(id, idx, { status: 'queued' });
  const job = jobTracker.createJob(id, 'image', idx);

  void (async () => {
    try {
      jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
      repo.updateShot(id, idx, { status: 'generating' });
      const early = repo.getShot(id, idx);
      if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });

      const { imageUrl, promptId, templateName } = await runShotImageGen({ project, shot, templateNameOverride });
      repo.updateShot(id, idx, { imageUrl, imagePromptId: promptId, status: 'ready' });
      jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl: imageUrl, message: `prompt=${promptId}; template=${templateName}` });
      const updatedShot = repo.getShot(id, idx);
      if (updatedShot) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updatedShot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancel = err instanceof ComfyJobCancelledError;
      repo.updateShot(id, idx, { status: isCancel ? 'pending' : 'error' });
      jobTracker.updateJob(job.id, { status: isCancel ? 'done' : 'error', message: isCancel ? 'cancelled (replaced by another run)' : msg });
      const updatedShot = repo.getShot(id, idx);
      if (updatedShot) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updatedShot });
      if (!isCancel && !(err instanceof ComfyJobExecutionError)) console.error('[videoboard.shotImage] unexpected error:', err);
    }
  })();

  return ctx.ok({ jobId: job.id });
});

export const generateAllImagesRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/shots/images/generate-all',
  params: IdParams,
  body: GenerateAllImagesBodySchema,
  response: GenerateAllResponseSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Queue image generation for all eligible shots (async)',
}, (ctx) => {
  const { id } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');
  if (project.shots.length === 0) throw new ValidationError('No shots to generate — run Analyze + Generate Storyboard first.');

  const batchTemplateName = ctx.body.templateName ?? undefined;

  const eligible = project.shots.filter(
    (s) => !s.imageUrl && s.status !== 'generating' && s.status !== 'queued' && !isInflight(id, s.idx),
  );
  if (eligible.length === 0) {
    return ctx.ok({ queued: [], skipped: project.shots.length, message: 'All shots already have images or are in flight.' });
  }

  for (const s of eligible) {
    repo.updateShot(id, s.idx, { status: 'queued' });
    const u = repo.getShot(id, s.idx);
    if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
  }

  for (const queuedShot of eligible) {
    void (async () => {
      const liveProject = repo.getProject(id);
      if (!liveProject) return;
      const liveShot = liveProject.shots.find((s) => s.idx === queuedShot.idx);
      if (!liveShot) return;
      const job = jobTracker.createJob(id, 'image', queuedShot.idx);
      try {
        jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
        repo.updateShot(id, queuedShot.idx, { status: 'generating' });
        const early = repo.getShot(id, queuedShot.idx);
        if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });
        const { imageUrl, promptId, templateName } = await runShotImageGen({ project: liveProject, shot: liveShot, templateNameOverride: batchTemplateName });
        repo.updateShot(id, queuedShot.idx, { imageUrl, imagePromptId: promptId, status: 'ready' });
        jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl: imageUrl, message: `prompt=${promptId}; template=${templateName}; batch` });
        const updated = repo.getShot(id, queuedShot.idx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isCancel = err instanceof ComfyJobCancelledError;
        repo.updateShot(id, queuedShot.idx, { status: isCancel ? 'pending' : 'error' });
        jobTracker.updateJob(job.id, { status: isCancel ? 'done' : 'error', message: isCancel ? 'cancelled (replaced by another run)' : msg });
        const updated = repo.getShot(id, queuedShot.idx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
      }
    })();
  }

  return ctx.ok({ queued: eligible.map((s) => s.idx), skipped: project.shots.length - eligible.length });
});

export const animateShotRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/shots/:idx/animate',
  params: IdxParams,
  body: AnimateShotBodySchema,
  response: JobStartedSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Generate video for a shot via FLF2V (async)',
}, (ctx) => {
  const { id, idx } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');
  const shot = project.shots.find((s) => s.idx === idx);
  if (!shot) throw new NotFoundError('Shot not found');
  const nextShot = project.shots.find((s) => s.idx === idx + 1);
  if (!nextShot) throw new ValidationError('Last shot has no next frame; video generation is skipped for the final shot.');
  if (!shot.imageUrl) throw new ValidationError('Shot has no image yet — generate the still image first.');
  if (!nextShot.imageUrl) throw new ValidationError(`Next shot (${nextShot.idx}) has no image yet — generate it first to use as the last frame.`);

  const templateNameOverride = ctx.body.templateName ?? undefined;
  repo.updateShot(id, idx, { status: 'queued' });
  const job = jobTracker.createJob(id, 'video', idx);

  void (async () => {
    try {
      jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
      repo.updateShot(id, idx, { status: 'generating' });
      const early = repo.getShot(id, idx);
      if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });
      const { videoUrl, promptId, templateName, frames } = await runShotVideoGen({ project, shot, nextShot, templateNameOverride });
      repo.updateShot(id, idx, { videoUrl, status: 'ready' });
      jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl: videoUrl, message: `prompt=${promptId}; template=${templateName}; frames=${frames}` });
      const updated = repo.getShot(id, idx);
      if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancel = err instanceof ComfyJobCancelledError;
      repo.updateShot(id, idx, { status: isCancel ? 'ready' : 'error' });
      jobTracker.updateJob(job.id, { status: isCancel ? 'done' : 'error', message: isCancel ? 'cancelled (replaced by another run)' : msg });
      const updated = repo.getShot(id, idx);
      if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
      if (!isCancel && !(err instanceof ComfyJobExecutionError)) console.error('[videoboard.shotVideo] unexpected error:', err);
    }
  })();

  return ctx.ok({ jobId: job.id });
});

export const generateAllVideosRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/shots/videos/generate-all',
  params: IdParams,
  body: GenerateAllVideosBodySchema,
  response: GenerateAllResponseSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Queue video generation for all eligible shots (async)',
}, (ctx) => {
  const { id } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');
  if (project.shots.length < 2) throw new ValidationError('Need at least 2 shots for FLF2V video generation.');

  const batchTemplateName = ctx.body.templateName ?? undefined;
  const shotsByIdx = new Map(project.shots.map((s) => [s.idx, s]));
  const eligible = project.shots.filter((s) => {
    if (s.idx === project.shots.length - 1) return false;
    if (!s.imageUrl) return false;
    const next = shotsByIdx.get(s.idx + 1);
    if (!next || !next.imageUrl) return false;
    if (s.videoUrl) return false;
    if (s.status === 'generating' || s.status === 'queued') return false;
    if (isVideoInflight(id, s.idx)) return false;
    return true;
  });
  if (eligible.length === 0) {
    return ctx.ok({ queued: [], skipped: project.shots.length, message: 'No shots eligible — all have videos already, or images missing, or in flight.' });
  }

  for (const s of eligible) {
    repo.updateShot(id, s.idx, { status: 'queued' });
    const u = repo.getShot(id, s.idx);
    if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
  }

  for (const queuedShot of eligible) {
    void (async () => {
      const liveProject = repo.getProject(id);
      if (!liveProject) return;
      const liveShot = liveProject.shots.find((s) => s.idx === queuedShot.idx);
      const liveNext = liveProject.shots.find((s) => s.idx === queuedShot.idx + 1);
      if (!liveShot || !liveNext) return;
      const job = jobTracker.createJob(id, 'video', queuedShot.idx);
      try {
        jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
        repo.updateShot(id, queuedShot.idx, { status: 'generating' });
        const early = repo.getShot(id, queuedShot.idx);
        if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });
        const { videoUrl, promptId, templateName, frames } = await runShotVideoGen({ project: liveProject, shot: liveShot, nextShot: liveNext, templateNameOverride: batchTemplateName });
        repo.updateShot(id, queuedShot.idx, { videoUrl, status: 'ready' });
        jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl: videoUrl, message: `prompt=${promptId}; template=${templateName}; frames=${frames}; batch` });
        const updated = repo.getShot(id, queuedShot.idx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isCancel = err instanceof ComfyJobCancelledError;
        repo.updateShot(id, queuedShot.idx, { status: isCancel ? 'ready' : 'error' });
        jobTracker.updateJob(job.id, { status: isCancel ? 'done' : 'error', message: isCancel ? 'cancelled (replaced by another run)' : msg });
        const updated = repo.getShot(id, queuedShot.idx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
      }
    })();
  }

  return ctx.ok({ queued: eligible.map((s) => s.idx), skipped: project.shots.length - eligible.length });
});

export const generateChainRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/shots/chain/generate',
  params: IdParams,
  body: GenerateChainBodySchema,
  response: ChainStartedSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Generate LTX-2.3 latent-chain videos serially (async)',
}, (ctx) => {
  const { id } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');
  if (project.shots.length === 0) throw new ValidationError('No shots to generate — run Analyze + Generate Storyboard first.');

  const startIdx = ctx.body.startIdx ?? 0;
  const lastIdx = project.shots.length - 1;
  const stopIdx = ctx.body.stopIdx ?? lastIdx;
  const startingImageUrl = ctx.body.startingImageUrl ?? undefined;
  const templateNameOverride = ctx.body.templateName ?? undefined;

  if (startIdx < 0 || startIdx > lastIdx) throw new ValidationError(`startIdx ${startIdx} out of range [0..${lastIdx}]`);
  if (stopIdx < startIdx || stopIdx > lastIdx) throw new ValidationError(`stopIdx ${stopIdx} must be in [${startIdx}..${lastIdx}]`);

  const seedShot = project.shots.find((s) => s.idx === startIdx);
  if (!seedShot) throw new ValidationError(`Shot ${startIdx} not found in project`);

  const predShotForImg = startIdx > 0 ? project.shots.find((s) => s.idx === startIdx - 1) : undefined;
  const seedImageUrl = startingImageUrl ?? seedShot.imageUrl ?? predShotForImg?.imageUrl ?? undefined;
  if (!seedImageUrl) {
    throw new ValidationError(`Shot ${startIdx} has no image and no startingImageUrl was provided. Generate the still image for the first shot first, or pass startingImageUrl in the body.`);
  }

  for (let i = startIdx; i <= stopIdx; i++) {
    if (isVideoChainInflight(id, i)) throw new ConflictError(`Shot ${i} already has a chain run in flight`);
    repo.updateShot(id, i, { status: 'queued' });
    const u = repo.getShot(id, i);
    if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
  }

  const job = jobTracker.createJob(id, 'video');

  let bootstrapPrevVideoUrl: string | undefined;
  let bootstrapPrevKeyVisual: string | undefined;
  if (startIdx > 0) {
    const predShot = project.shots.find((s) => s.idx === startIdx - 1);
    if (predShot?.videoUrl) bootstrapPrevVideoUrl = predShot.videoUrl;
    bootstrapPrevKeyVisual = predShot?.keyVisual;
  }

  void (async () => {
    let prevVideoUrl: string | undefined = bootstrapPrevVideoUrl;
    let prevKeyVisual: string | undefined = bootstrapPrevKeyVisual;
    let resolvedSeedImageUrl: string | undefined = seedImageUrl;
    jobTracker.updateJob(job.id, { status: 'running', progress: 0.05 });

    if (!prevVideoUrl && !viewUrlPointsToExistingFile(resolvedSeedImageUrl)) {
      try {
        jobTracker.updateJob(job.id, { status: 'running', progress: 0.02, message: `shot ${startIdx} seed image missing on disk — regenerating still` });
        repo.updateShot(id, startIdx, { status: 'generating' });
        const early = repo.getShot(id, startIdx);
        if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });
        const imgResult = await runShotImageGen({ project, shot: seedShot });
        repo.updateShot(id, startIdx, { imageUrl: imgResult.imageUrl, imagePromptId: imgResult.promptId });
        const updated = repo.getShot(id, startIdx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
        resolvedSeedImageUrl = imgResult.imageUrl;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        repo.updateShot(id, startIdx, { status: 'error' });
        const updated = repo.getShot(id, startIdx);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
        for (let j = startIdx + 1; j <= stopIdx; j++) {
          repo.updateShot(id, j, { status: 'pending' });
          const u = repo.getShot(id, j);
          if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
        }
        jobTracker.updateJob(job.id, { status: 'error', message: `seed image regeneration failed for shot ${startIdx}: ${msg}` });
        return;
      }
    }

    let imageUrlForThisStep: string | undefined = prevVideoUrl ? undefined : resolvedSeedImageUrl;

    for (let i = startIdx; i <= stopIdx; i++) {
      const liveProject = repo.getProject(id);
      if (!liveProject) { jobTracker.updateJob(job.id, { status: 'error', message: 'project deleted mid-chain' }); return; }
      const liveShot = liveProject.shots.find((s) => s.idx === i);
      if (!liveShot) { jobTracker.updateJob(job.id, { status: 'error', message: `shot ${i} disappeared mid-chain` }); return; }

      try {
        repo.updateShot(id, i, { status: 'generating' });
        const early = repo.getShot(id, i);
        if (early) emit({ type: 'videoboard:shot:updated', projectId: id, shot: early });

        const result = await runShotVideoChainGen({ project: liveProject, shot: liveShot, prevVideoUrl, prevKeyVisual, startingImageUrl: imageUrlForThisStep, templateNameOverride });

        repo.updateShot(id, i, { videoUrl: result.videoUrl, status: 'ready' });
        const updated = repo.getShot(id, i);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });

        prevVideoUrl = result.videoUrl;
        prevKeyVisual = liveShot.keyVisual;
        imageUrlForThisStep = undefined;

        const progress = (i - startIdx + 1) / (stopIdx - startIdx + 1);
        jobTracker.updateJob(job.id, {
          status: i === stopIdx ? 'done' : 'running',
          progress,
          outputUrl: result.videoUrl,
          message: `shot ${i}: prompt=${result.promptId}; lastFrame=${result.lastFrameUrl}; frames=${result.frames}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isCancel = err instanceof ComfyJobCancelledError;
        repo.updateShot(id, i, { status: isCancel ? 'pending' : 'error' });
        const updated = repo.getShot(id, i);
        if (updated) emit({ type: 'videoboard:shot:updated', projectId: id, shot: updated });
        for (let j = i + 1; j <= stopIdx; j++) {
          repo.updateShot(id, j, { status: 'pending' });
          const u = repo.getShot(id, j);
          if (u) emit({ type: 'videoboard:shot:updated', projectId: id, shot: u });
        }
        jobTracker.updateJob(job.id, { status: isCancel ? 'done' : 'error', message: isCancel ? `cancelled at shot ${i} (replaced by another run)` : `failed at shot ${i}: ${msg}` });
        if (!isCancel && !(err instanceof ComfyJobExecutionError)) console.error('[videoboard.shotVideoChain] unexpected error:', err);
        return;
      }
    }
  })();

  return ctx.ok({ jobId: job.id, startIdx, stopIdx, shotCount: stopIdx - startIdx + 1 });
});
