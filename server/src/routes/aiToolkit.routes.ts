// Image-LoRA training routes (AI-Toolkit capability pack).
// GET  /api/ai-toolkit/base-models            — local checkpoints + HF presets. Scope: system:read.
// GET  /api/ai-toolkit/datasets                — list uploaded datasets.        Scope: system:read.
// POST /api/ai-toolkit/datasets/:name/upload   — upload images (+captions).     Scope: generate:write.
// POST /api/ai-toolkit/jobs                    — start a training run.         Scope: generate:write.
// GET  /api/ai-toolkit/jobs                     — list jobs.                     Scope: system:read.
// GET  /api/ai-toolkit/jobs/:id                 — poll one job's status.         Scope: system:read.
// GET  /api/ai-toolkit/jobs/:id/logs            — tail the live log ring buffer. Scope: system:read.
// POST /api/ai-toolkit/jobs/:id/cancel          — cancel a queued/running job.   Scope: generate:write.
//
// GPU-scheduler design: training itself is submitted via
// `submitGpuJob('image-lora-train', ...)` inside `services/aiToolkit/train.ts`
// (tenant `oneshot`, uncapped `maxRuntimeMs` — see `services/gpu/taskTypes.ts`).
// `startTrainingJob` returns as soon as the job is accepted/queued — it does
// NOT block the route on the scheduler slot or the run itself, matching
// `routes/ace/training.routes.ts`'s kickoff routes. Poll `GET /jobs/:id`
// (and `GET /gpu` for the "why is comfy generation queued" banner) instead.

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer, { MulterError } from 'multer';
import type { Request, Response, NextFunction } from 'express';
import type { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { ConflictError, HttpError, NotFoundError, ValidationError } from '../lib/errors.js';
import { authMiddleware } from '../middleware/auth.js';
import { paths } from '../config/paths.js';
import { safeResolve } from '../lib/fs.js';
import * as train from '../services/aiToolkit/train.js';
import { listDatasets, IMAGE_EXTS } from '../services/aiToolkit/datasets.js';
import { listLocalBaseModels, HF_BASE_MODEL_PRESETS } from '../services/aiToolkit/baseModels.js';
import { sanitizeIdentifier } from '../services/aiToolkit/util.js';
import type { AiToolkitArch } from '../services/aiToolkit/config.js';
import type { AiToolkitJobRow } from '../lib/db/aiToolkit.repo.js';
import {
  BaseModelsResponseSchema,
  DatasetListResponseSchema,
  DatasetUploadParamsSchema,
  DatasetUploadResponseSchema,
  StartTrainingBodySchema,
  StartTrainingResponseSchema,
  JobListQuerySchema,
  JobListResponseSchema,
  JobParamsSchema,
  AiToolkitJobViewSchema,
  CancelJobResponseSchema,
  JobLogsResponseSchema,
} from '../contracts/aiToolkit.contract.js';

const router = Router();

// ---------------------------------------------------------------------------
// Wire mapping — strips absolute host paths (see contract file header).
// ---------------------------------------------------------------------------

function toJobView(job: AiToolkitJobRow): z.infer<typeof AiToolkitJobViewSchema> {
  const arch = typeof job.config.arch === 'string' ? (job.config.arch as AiToolkitArch) : null;
  return {
    id: job.id,
    name: job.name,
    baseModel: job.baseModel,
    arch,
    datasetName: job.datasetPath ? path.basename(job.datasetPath) : null,
    status: job.status,
    progress: job.progress,
    step: job.step,
    totalSteps: job.totalSteps,
    outputFilename: job.outputPath ? path.basename(job.outputPath) : null,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /ai-toolkit/base-models
// ---------------------------------------------------------------------------

const baseModelsRoute = defineRoute({
  method: 'GET',
  path: '/ai-toolkit/base-models',
  response: BaseModelsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ai-toolkit'],
  summary: 'List locally installed checkpoints + HuggingFace base-model presets',
}, ({ ok }) => ok({ local: listLocalBaseModels(), presets: HF_BASE_MODEL_PRESETS }));

// ---------------------------------------------------------------------------
// GET /ai-toolkit/datasets
// ---------------------------------------------------------------------------

const datasetsRoute = defineRoute({
  method: 'GET',
  path: '/ai-toolkit/datasets',
  response: DatasetListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ai-toolkit'],
  summary: 'List image-LoRA training datasets',
}, ({ ok }) => ok({ items: listDatasets() }));

// ---------------------------------------------------------------------------
// POST /ai-toolkit/datasets/:name/upload — multipart; spec registered via
// `defineRoute` for OpenAPI/audit only (multer must run before body
// handling — same pattern as `routes/ace/training.routes.ts`'s upload-audio).
// ---------------------------------------------------------------------------

const datasetUploadSpec = {
  method: 'POST' as const,
  path: '/ai-toolkit/datasets/:name/upload',
  params: DatasetUploadParamsSchema,
  response: DatasetUploadResponseSchema,
  auth: { required: true, scopes: ['generate:write'] as const },
  tags: ['ai-toolkit'],
  summary: 'Upload images (+ optional .txt captions) into a dataset',
};

// Registered for OpenAPI/audit visibility only — never actually invoked.
defineRoute(datasetUploadSpec, async () => ({ data: { name: '', uploadedCount: 0, imageCount: 0, captionedCount: 0 } }));

const datasetUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const name = sanitizeIdentifier(Array.isArray(req.params.name) ? req.params.name[0] : req.params.name);
      let dest: string;
      try {
        dest = safeResolve(paths.aiToolkitDatasetsDir, name);
      } catch (err) {
        cb(err as Error, paths.aiToolkitDatasetsDir);
        return;
      }
      fs.mkdir(dest, { recursive: true }, (err) => cb(err, dest));
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-. ]/g, '_');
      cb(null, `${base}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 500 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXTS.has(ext) || ext === '.txt') {
      cb(null, true);
    } else {
      cb(new ValidationError(`Unsupported file type: ${ext}. Allowed: ${[...IMAGE_EXTS, '.txt'].join(', ')}`));
    }
  },
});

function handleUploadError(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new HttpError('payload_too_large', 'File too large', { maxBytes: 25 * 1024 * 1024 }));
    return;
  }
  next(err);
}

router.post(
  '/ai-toolkit/datasets/:name/upload',
  authMiddleware(datasetUploadSpec.auth),
  (req, res, next) => datasetUpload.array('files', 500)(req, res, (err) => {
    if (err) { handleUploadError(err, req, res, next); return; }
    next();
  }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) throw new ValidationError('No files uploaded');
      const name = sanitizeIdentifier(Array.isArray(req.params.name) ? req.params.name[0] : req.params.name);
      const dir = safeResolve(paths.aiToolkitDatasetsDir, name);
      const onDisk = fs.readdirSync(dir);
      const images = onDisk.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
      const captionedCount = images.filter((f) => onDisk.includes(`${path.basename(f, path.extname(f))}.txt`)).length;
      res.json({
        data: {
          name,
          uploadedCount: files.length,
          imageCount: images.length,
          captionedCount,
        },
      });
    } catch (err) {
      if (err instanceof Error) next(err);
      else next(new HttpError('internal_error', 'Upload failed'));
    }
  },
);

// ---------------------------------------------------------------------------
// POST /ai-toolkit/jobs
// ---------------------------------------------------------------------------

const startJobRoute = defineRoute({
  method: 'POST',
  path: '/ai-toolkit/jobs',
  body: StartTrainingBodySchema,
  response: StartTrainingResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ai-toolkit'],
  summary: 'Start an image-LoRA training run',
}, ({ body, ok }) => ok(train.startTrainingJob(body)));

// ---------------------------------------------------------------------------
// GET /ai-toolkit/jobs
// ---------------------------------------------------------------------------

const listJobsRoute = defineRoute({
  method: 'GET',
  path: '/ai-toolkit/jobs',
  query: JobListQuerySchema,
  response: JobListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ai-toolkit'],
  summary: 'List image-LoRA training jobs, most recent first',
}, ({ query, ok }) => ok({ items: train.listTrainingJobs(query.limit).map(toJobView) }));

// ---------------------------------------------------------------------------
// GET /ai-toolkit/jobs/:id
// ---------------------------------------------------------------------------

const getJobRoute = defineRoute({
  method: 'GET',
  path: '/ai-toolkit/jobs/:id',
  params: JobParamsSchema,
  response: AiToolkitJobViewSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ai-toolkit'],
  summary: 'Poll a single training job\'s status/progress',
}, ({ params, ok }) => {
  const job = train.getTrainingJob(params.id);
  if (!job) throw new NotFoundError('Job not found');
  return ok(toJobView(job));
});

// ---------------------------------------------------------------------------
// GET /ai-toolkit/jobs/:id/logs
// ---------------------------------------------------------------------------

const jobLogsRoute = defineRoute({
  method: 'GET',
  path: '/ai-toolkit/jobs/:id/logs',
  params: JobParamsSchema,
  response: JobLogsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ai-toolkit'],
  summary: 'Tail a training job\'s live log ring buffer',
}, ({ params, ok }) => {
  const job = train.getTrainingJob(params.id);
  if (!job) throw new NotFoundError('Job not found');
  return ok({ lines: train.getTrainingJobLogs(params.id) });
});

// ---------------------------------------------------------------------------
// POST /ai-toolkit/jobs/:id/cancel
// ---------------------------------------------------------------------------

const cancelJobRoute = defineRoute({
  method: 'POST',
  path: '/ai-toolkit/jobs/:id/cancel',
  params: JobParamsSchema,
  response: CancelJobResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ai-toolkit'],
  summary: 'Cancel a queued or running training job',
}, ({ params, ok }) => {
  const result = train.cancelTrainingJob(params.id);
  if (result === 'not_found') throw new NotFoundError('Job not found');
  if (result === 'already_terminal') throw new ConflictError('Job already finished');
  return ok({ jobId: params.id, cancelled: true });
});

[
  baseModelsRoute, datasetsRoute, startJobRoute, listJobsRoute, getJobRoute, jobLogsRoute, cancelJobRoute,
].forEach((r) => r.register(router));

export default router;
