// Zod schemas for the AI-Toolkit (image-LoRA training) routes:
// GET  /api/ai-toolkit/base-models
// GET  /api/ai-toolkit/datasets
// POST /api/ai-toolkit/datasets/:name/upload   (multipart; spec registered
//   for OpenAPI/audit only — see routes/aiToolkit.routes.ts, same pattern as
//   contracts/ace/training.contract.ts's upload-audio)
// POST /api/ai-toolkit/jobs
// GET  /api/ai-toolkit/jobs
// GET  /api/ai-toolkit/jobs/:id
// GET  /api/ai-toolkit/jobs/:id/logs
// POST /api/ai-toolkit/jobs/:id/cancel
//
// Job responses deliberately omit absolute host filesystem paths
// (`datasetPath`, raw `outputPath`, the internal `config` blob) — only
// `outputFilename` (basename) is exposed once a job succeeds, matching the
// "never expose absolute host paths unnecessarily" constraint the rest of
// the API follows (e.g. `services/models/service.ts` strips `COMFYUI_PATH`
// before echoing catalog paths back to the client).

import { z } from 'zod';

export const AiToolkitArchSchema = z.enum(['flux', 'sdxl', 'sd35', 'other']);
export type AiToolkitArchWire = z.infer<typeof AiToolkitArchSchema>;

// ---------------------------------------------------------------------------
// GET /ai-toolkit/base-models
// ---------------------------------------------------------------------------

export const LocalBaseModelSchema = z.object({
  source: z.literal('local'),
  id: z.string(),
  folder: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const HfBaseModelPresetSchema = z.object({
  source: z.literal('huggingface'),
  id: z.string(),
  label: z.string(),
  arch: AiToolkitArchSchema,
  note: z.string().optional(),
});

export const BaseModelsResponseSchema = z.object({
  local: z.array(LocalBaseModelSchema),
  presets: z.array(HfBaseModelPresetSchema),
});

// ---------------------------------------------------------------------------
// GET /ai-toolkit/datasets
// ---------------------------------------------------------------------------

export const DatasetSummarySchema = z.object({
  name: z.string(),
  imageCount: z.number().int().nonnegative(),
  captionedCount: z.number().int().nonnegative(),
  updatedAt: z.number().nullable(),
});

export const DatasetListResponseSchema = z.object({
  items: z.array(DatasetSummarySchema),
});

// ---------------------------------------------------------------------------
// POST /ai-toolkit/datasets/:name/upload (multipart; spec registered for
// OpenAPI/audit only)
// ---------------------------------------------------------------------------

export const DatasetUploadParamsSchema = z.object({
  name: z.string().min(1).max(120),
});

export const DatasetUploadResponseSchema = z.object({
  name: z.string(),
  uploadedCount: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  captionedCount: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// POST /ai-toolkit/jobs
// ---------------------------------------------------------------------------

export const StartTrainingBodySchema = z.object({
  name: z.string().min(1).max(120),
  baseModel: z.string().min(1).max(500),
  arch: AiToolkitArchSchema,
  datasetName: z.string().min(1).max(120),
  triggerWord: z.string().max(200).optional(),
  steps: z.number().int().min(1).max(100_000),
  learningRate: z.number().positive().max(1),
  rank: z.number().int().min(1).max(512),
  alpha: z.number().positive().max(1024).optional(),
  batchSize: z.number().int().min(1).max(64),
  resolution: z.number().int().min(64).max(2048),
  saveEvery: z.number().int().min(1).max(100_000),
  seed: z.number().int().optional(),
  lowVram: z.boolean().optional(),
});

export const StartTrainingResponseSchema = z.object({
  jobId: z.string(),
});

// ---------------------------------------------------------------------------
// Job status shape shared by GET /jobs, GET /jobs/:id, POST /jobs
// ---------------------------------------------------------------------------

export const AiToolkitJobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export const AiToolkitJobViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseModel: z.string(),
  arch: AiToolkitArchSchema.nullable(),
  datasetName: z.string().nullable(),
  status: AiToolkitJobStatusSchema,
  progress: z.number(),
  step: z.number().int(),
  totalSteps: z.number().int(),
  /** Basename only — never the absolute host path. Set once the job
   *  succeeds and the LoRA has been copied into ComfyUI's loras dir. */
  outputFilename: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ---------------------------------------------------------------------------
// GET /ai-toolkit/jobs
// ---------------------------------------------------------------------------

export const JobListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const JobListResponseSchema = z.object({
  items: z.array(AiToolkitJobViewSchema),
});

// ---------------------------------------------------------------------------
// GET /ai-toolkit/jobs/:id, POST /ai-toolkit/jobs/:id/cancel,
// GET /ai-toolkit/jobs/:id/logs
// ---------------------------------------------------------------------------

export const JobParamsSchema = z.object({
  id: z.string().min(1),
});

export const CancelJobResponseSchema = z.object({
  jobId: z.string(),
  cancelled: z.boolean(),
});

export const JobLogsResponseSchema = z.object({
  lines: z.array(z.string()),
});
