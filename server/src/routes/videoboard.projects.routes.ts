// Videoboard — project + audio + analysis routes.
// Handles: CRUD projects, audio upload/stream/delete, analyze, get analysis.

import fs from 'fs';
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError, InternalError } from '../lib/errors.js';
import * as repo from '../lib/db/videoboard.repo.js';
import * as jobTracker from '../services/videoboard/jobTracker.js';
import * as storage from '../services/videoboard/storage.js';
import { paths } from '../config/paths.js';
import { analyzeViaComfyUI } from '../services/videoboard/runAnalyze.js';
import {
  ProjectSchema,
  AnalysisSchema,
  JobStartedSchema,
  OkSchema,
  CreateProjectBodySchema,
  UpdateProjectBodySchema,
  GenerateStoryboardBodySchema,
} from '../contracts/videoboard.js';
import { scenesViaComfyUI, type DirectorShot } from '../services/videoboard/runScenes.js';
import { deleteOrphanedFiles } from './videoboard.shared.js';
import { runShotImageGen } from '../services/videoboard/runShotImageGen.js';
import type { Shot } from '../contracts/videoboard.js';
import path from 'path';

// ---- Multer ------------------------------------------------------------------

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, paths.uploadsTmpDir),
    filename: (_req, _file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ---- Broadcast accessor (set by videoboard.routes.ts) -----------------------

let _emit: ((p: object) => void) | null = null;
export function setProjectsEmitter(fn: ((p: object) => void) | null): void { _emit = fn; }
function emit(p: object): void { if (_emit) _emit(p); }

// ---- Route specs + handlers --------------------------------------------------

const IdParams = z.object({ id: z.string() });

export const listProjectsRoute = defineRoute({
  method: 'GET',
  path: '/videoboard/projects',
  response: z.array(ProjectSchema),
  auth: { required: true, scopes: ['videoboard:read'] },
  tags: ['videoboard'],
  summary: 'List all projects',
}, (ctx) => ctx.ok(repo.listProjects()));

export const createProjectRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects',
  body: CreateProjectBodySchema,
  response: ProjectSchema,
  auth: { required: true, scopes: ['videoboard:write'] },
  tags: ['videoboard'],
  summary: 'Create a project',
}, (ctx) => {
  const project = repo.createProject(randomUUID(), ctx.body.name ?? 'Untitled');
  ctx.res.status(201);
  return ctx.ok(project);
});

export const getProjectRoute = defineRoute({
  method: 'GET',
  path: '/videoboard/projects/:id',
  params: IdParams,
  response: ProjectSchema,
  auth: { required: true, scopes: ['videoboard:read'] },
  tags: ['videoboard'],
  summary: 'Get a project',
}, (ctx) => {
  const project = repo.getProject(ctx.params.id);
  if (!project) throw new NotFoundError('Project not found');
  return ctx.ok(project);
});

export const updateProjectRoute = defineRoute({
  method: 'PUT',
  path: '/videoboard/projects/:id',
  params: IdParams,
  body: UpdateProjectBodySchema,
  response: ProjectSchema,
  auth: { required: true, scopes: ['videoboard:write'] },
  tags: ['videoboard'],
  summary: 'Update a project',
}, (ctx) => {
  const updated = repo.updateProject(ctx.params.id, ctx.body as Parameters<typeof repo.updateProject>[1]);
  if (!updated) throw new NotFoundError('Project not found');
  return ctx.ok(updated);
});

export const deleteProjectRoute = defineRoute({
  method: 'DELETE',
  path: '/videoboard/projects/:id',
  params: IdParams,
  response: OkSchema,
  auth: { required: true, scopes: ['videoboard:write'] },
  tags: ['videoboard'],
  summary: 'Delete a project',
}, (ctx) => {
  const deleted = repo.deleteProject(ctx.params.id);
  if (!deleted) throw new NotFoundError('Project not found');
  return ctx.ok({ ok: true as const });
});

export const getAnalysisRoute = defineRoute({
  method: 'GET',
  path: '/videoboard/projects/:id/analysis',
  params: IdParams,
  response: AnalysisSchema.nullable(),
  auth: { required: true, scopes: ['videoboard:read'] },
  tags: ['videoboard'],
  summary: 'Get audio analysis for a project',
}, (ctx) => ctx.ok(repo.getAnalysis(ctx.params.id)));

export const analyzeRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/analyze',
  params: IdParams,
  response: JobStartedSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Analyze project audio (async)',
}, (ctx) => {
  const { id } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');
  if (!project.audioPath) throw new ValidationError('Project has no audio uploaded');
  if (!fs.existsSync(project.audioPath)) throw new ValidationError('Audio file missing on disk');

  repo.updateProject(id, { analysisStatus: 'pending' });
  const job = jobTracker.createJob(id, 'analyze');

  const expectedAudioPath = project.audioPath;
  void (async () => {
    function audioStillThere(): boolean {
      const p = repo.getProject(id);
      return !!p && p.audioPath === expectedAudioPath;
    }
    try {
      jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
      const { analysis, promptId } = await analyzeViaComfyUI({
        audioPath: expectedAudioPath,
        identifier: id,
      });
      if (!audioStillThere()) {
        jobTracker.updateJob(job.id, { status: 'error', message: 'cancelled: audio was removed mid-analyze' });
        return;
      }
      repo.upsertAnalysis(id, analysis);
      repo.updateProject(id, { analysisStatus: 'ready', audioDurationMs: analysis.duration_ms });
      jobTracker.updateJob(job.id, { status: 'done', progress: 1, message: `prompt=${promptId}` });
      const updated = repo.getProject(id);
      if (updated) emit({ type: 'videoboard:project:updated', project: updated });
      emit({ type: 'videoboard:analysis:updated', projectId: id, analysis });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (audioStillThere()) {
        repo.updateProject(id, { analysisStatus: 'error' });
        const updated = repo.getProject(id);
        if (updated) emit({ type: 'videoboard:project:updated', project: updated });
      }
      jobTracker.updateJob(job.id, { status: 'error', message: msg });
    }
  })();

  return ctx.ok({ jobId: job.id });
});

export const generateStoryboardRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/projects/:id/storyboard/generate',
  params: IdParams,
  body: GenerateStoryboardBodySchema,
  response: JobStartedSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['videoboard'],
  summary: 'Generate storyboard shots (async)',
}, (ctx) => {
  const { id } = ctx.params;
  const project = repo.getProject(id);
  if (!project) throw new NotFoundError('Project not found');
  if (!project.audioPath) throw new ValidationError('Project has no audio uploaded');
  if (!fs.existsSync(project.audioPath)) throw new ValidationError('Audio file missing on disk');
  if (project.analysisStatus !== 'ready') {
    throw new ValidationError('Analyze the audio before generating the storyboard');
  }
  const analysis = repo.getAnalysis(id);
  if (!analysis) throw new ValidationError('Analysis row is missing — re-run Analyze');

  const orphanedUrls: string[] = [];
  for (const s of project.shots ?? []) {
    if (s.imageUrl) orphanedUrls.push(s.imageUrl);
    if (s.videoUrl) orphanedUrls.push(s.videoUrl);
  }
  if (project.shots && project.shots.length > 0) {
    repo.deleteShots(id);
    deleteOrphanedFiles(orphanedUrls);
  }

  const job = jobTracker.createJob(id, 'storyboard');
  repo.updateProject(id, { status: 'generating' });

  const projectAfterDelete = repo.getProject(id);
  if (projectAfterDelete) emit({ type: 'videoboard:project:updated', project: projectAfterDelete });

  const expectedAudioPath = project.audioPath;
  void (async () => {
    function audioStillThere(): boolean {
      const p = repo.getProject(id);
      return !!p && p.audioPath === expectedAudioPath;
    }
    try {
      jobTracker.updateJob(job.id, { status: 'running', progress: 0.1 });
      const { shots: directorShots, promptId, treatment } = await scenesViaComfyUI({
        audioPath: expectedAudioPath,
        analysisJson: JSON.stringify(analysis),
        identifier: id,
        shotSeconds: project.settings.fixedShotSeconds,
        styleHint: project.settings.styleHint,
      });
      if (!audioStillThere()) {
        jobTracker.updateJob(job.id, { status: 'error', message: 'cancelled: audio was removed mid-generate' });
        return;
      }
      const shots: Shot[] = directorShots.map((s: DirectorShot, i: number) => ({
        idx: i,
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        lyrics: '',
        prompt: s.image_prompt || s.description,
        seed: Math.floor(Math.random() * 2 ** 31),
        status: 'pending' as const,
        imagePrompt: s.image_prompt,
        videoPrompt: s.video_prompt,
        keyVisual: s.key_visual,
        treatmentSnapshot: s.treatment_snapshot,
        chunkIdx: s.chunk_idx,
      }));
      repo.replaceShots(id, shots);
      repo.updateProject(id, { status: 'draft' });
      jobTracker.updateJob(job.id, {
        status: 'done', progress: 1.0,
        message: `prompt=${promptId}; ${shots.length} shots; treatment ${treatment.length}ch`,
      });
      const updated = repo.getProject(id);
      if (updated) emit({ type: 'videoboard:project:updated', project: updated });
      for (const s of shots) emit({ type: 'videoboard:shot:updated', projectId: id, shot: s });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (audioStillThere()) {
        repo.updateProject(id, { status: 'draft' });
        const updated = repo.getProject(id);
        if (updated) emit({ type: 'videoboard:project:updated', project: updated });
      }
      jobTracker.updateJob(job.id, { status: 'error', message: msg });
    }
  })();

  return ctx.ok({ jobId: job.id });
});

// ---- Audio routes (multer — registered manually, not via defineRoute) --------
// Multer parses multipart; defineRoute's body-parse shim only handles JSON.
// We still wrap responses in the canonical envelope manually.

export function registerAudioRoutes(router: Router): void {
  // POST /api/videoboard/projects/:id/audio
  router.post(
    '/videoboard/projects/:id/audio',
    audioUpload.single('audio'),
    (req, res, next): void => {
      try {
        const id = req.params.id as string;
        const project = repo.getProject(id);
        if (!project) throw new NotFoundError('Project not found');
        if (!req.file) throw new ValidationError('No audio file provided');
        const ext = path.extname(req.file.originalname).replace('.', '') || 'mp3';
        storage.ensureProjectDir(id);
        const dest = storage.audioPath(id, ext);
        fs.renameSync(req.file.path, dest);
        repo.deleteAnalysis(id);
        repo.deleteShots(id);
        const replaced = repo.updateProject(id, {
          audioPath: dest,
          audioDurationMs: undefined,
          analysisStatus: 'none',
        });
        if (replaced) emit({ type: 'videoboard:project:updated', project: replaced });
        res.json({ data: { audioPath: dest } });
      } catch (err) {
        next(err instanceof Error ? err : new InternalError('Audio upload failed'));
      }
    },
  );

  // GET /api/videoboard/projects/:id/audio
  router.get('/videoboard/projects/:id/audio', (req, res, next): void => {
    try {
      const project = repo.getProject(req.params.id as string);
      if (!project?.audioPath) throw new NotFoundError('No audio uploaded');
      if (!fs.existsSync(project.audioPath)) throw new NotFoundError('Audio file missing');
      res.sendFile(project.audioPath);
    } catch (err) {
      next(err instanceof Error ? err : new InternalError('Audio fetch failed'));
    }
  });

  // DELETE /api/videoboard/projects/:id/audio
  router.delete('/videoboard/projects/:id/audio', (req, res, next): void => {
    try {
      const id = req.params.id as string;
      const project = repo.getProject(id);
      if (!project) throw new NotFoundError('Project not found');
      if (project.audioPath) {
        try { fs.unlinkSync(project.audioPath); } catch { /* may already be gone */ }
      }
      repo.deleteAnalysis(id);
      repo.deleteShots(id);
      const updated = repo.updateProject(id, {
        audioPath: undefined,
        audioDurationMs: undefined,
        analysisStatus: 'none',
      });
      if (updated) emit({ type: 'videoboard:project:updated', project: updated });
      res.json({ data: updated });
    } catch (err) {
      next(err instanceof Error ? err : new InternalError('Audio delete failed'));
    }
  });
}

