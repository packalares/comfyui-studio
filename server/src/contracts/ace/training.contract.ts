// Zod schemas for the ACE-Step training/LoRA-dataset routes:
// POST /api/ace/training/upload-audio, /transcribe-uploads, /build-dataset,
// /preprocess, /auto-label, /init-model, /load-dataset, /sample-preview
// (GET), /save-sample, /update-settings, /start, /stop,
// /preprocess-stems, GET .../checkpoints, /lora-checkpoints,
// /preprocess-status, /auto-label-status, /training-status,
// /preprocess-stems-status, /limits.
//
// Several endpoints (the *-status polls, save-sample) proxy ACE-Step's
// FastAPI response mostly as-is — those use `z.record(z.string(),
// z.unknown())` rather than fully modeling the upstream shape, matching the
// passthrough convention already used elsewhere (see e.g.
// `contracts/generate.contract.ts`'s `node_errors`).

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared sample/settings shapes (build-dataset, load-dataset, sample-preview,
// save-sample all move data in this shape).
// ---------------------------------------------------------------------------

export const TrainingSampleSchema = z.object({
  index: z.number().optional(),
  audio: z.string().nullable().optional(),
  filename: z.string(),
  caption: z.string(),
  genre: z.string(),
  promptOverride: z.string().nullable().optional(),
  lyrics: z.string(),
  bpm: z.number().nullable().optional(),
  key: z.string(),
  timeSignature: z.string(),
  duration: z.number(),
  language: z.string(),
  instrumental: z.boolean(),
  rawLyrics: z.string(),
});

export const TrainingDatasetSettingsSchema = z.object({
  datasetName: z.string(),
  customTag: z.string(),
  tagPosition: z.string(),
  allInstrumental: z.boolean(),
  genreRatio: z.number(),
});

export const DatasetBuildResultSchema = z.object({
  status: z.string(),
  dataframe: z.unknown().nullable().optional(),
  sampleCount: z.number(),
  sample: TrainingSampleSchema.nullable(),
  settings: TrainingDatasetSettingsSchema,
  datasetPath: z.string(),
});

// ---------------------------------------------------------------------------
// POST /ace/training/upload-audio (multipart; spec registered for
// OpenAPI/audit only — see routes/ace/training.routes.ts for why)
// ---------------------------------------------------------------------------

export const UploadTrainingAudioResponseSchema = z.object({
  files: z.array(z.object({
    filename: z.string(),
    originalName: z.string(),
    size: z.number(),
    path: z.string(),
  })),
  uploadDir: z.string(),
  count: z.number(),
});

// ---------------------------------------------------------------------------
// POST /ace/training/transcribe-uploads
// ---------------------------------------------------------------------------

export const TranscribeUploadsBodySchema = z.object({
  datasetName: z.string().min(1),
});

export const TranscribeUploadsResponseSchema = z.object({
  status: z.string(),
  dir: z.string(),
});

// Whisper batch transcription is started asynchronously (see
// `routes/ace/training.routes.ts`) — the POST above returns as soon as the job
// is registered, and the client polls this to completion.
export const TranscribeUploadsStatusQuerySchema = z.object({
  datasetName: z.string().min(1),
});

export const TranscribeUploadsStatusResponseSchema = z.object({
  status: z.enum(['idle', 'running', 'succeeded', 'failed']),
  dir: z.string().optional(),
  error: z.string().optional(),
  /** Tail of whisper's stdout, newest last. */
  lines: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// POST /ace/training/build-dataset
// ---------------------------------------------------------------------------

export const BuildDatasetBodySchema = z.object({
  datasetName: z.string().min(1).default('my_lora_dataset'),
  customTag: z.string().default(''),
  tagPosition: z.enum(['prepend', 'append']).default('prepend'),
  allInstrumental: z.boolean().default(true),
});

export const BuildDatasetResponseSchema = DatasetBuildResultSchema;

// ---------------------------------------------------------------------------
// POST /ace/training/preprocess (kicks off ACE-Step's async tensor
// preprocessing) + GET /ace/training/preprocess-status
// ---------------------------------------------------------------------------

export const PreprocessBodySchema = z.object({
  datasetPath: z.string().min(1),
  outputDir: z.string().optional(),
});

export const PreprocessResponseSchema = z.object({
  task_id: z.string().optional(),
  status: z.string(),
});

export const PreprocessStatusResponseSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// POST /ace/training/auto-label + GET /ace/training/auto-label-status
// ---------------------------------------------------------------------------

export const AutoLabelBodySchema = z.object({
  skipMetas: z.boolean().default(false),
  formatLyrics: z.boolean().default(false),
  transcribeLyrics: z.boolean().default(false),
  onlyUnlabeled: z.boolean().default(false),
});

export const AutoLabelResponseSchema = z.object({
  task_id: z.string().optional(),
  total: z.number().optional(),
  status: z.string(),
});

export const AutoLabelStatusResponseSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// POST /ace/training/init-model
// ---------------------------------------------------------------------------

export const InitModelBodySchema = z.object({
  checkpoint: z.string().default(''),
  initLlm: z.boolean().default(false),
  lmModelPath: z.string().default(''),
  reinitialize: z.boolean().default(false),
});

export const InitModelResponseSchema = z.object({
  status: z.string(),
  modelReady: z.boolean(),
});

// ---------------------------------------------------------------------------
// GET /ace/training/checkpoints — DiT checkpoints installed by the ace-step
// pack (registry.ts), not a scan of a checked-out ACE-Step source tree
// (comfy has none — `ace-step` is a plain pip package here).
// ---------------------------------------------------------------------------

export const CheckpointsListResponseSchema = z.object({
  checkpoints: z.array(z.string()),
  configs: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// GET /ace/training/lora-checkpoints
// ---------------------------------------------------------------------------

export const LoraCheckpointsQuerySchema = z.object({
  dir: z.string().optional(),
});

export const LoraCheckpointsResponseSchema = z.object({
  checkpoints: z.array(z.string()),
  outputDir: z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /ace/training/load-dataset
// ---------------------------------------------------------------------------

export const LoadDatasetBodySchema = z.object({
  datasetPath: z.string().min(1),
});

export const LoadDatasetResponseSchema = DatasetBuildResultSchema;

// ---------------------------------------------------------------------------
// GET /ace/training/sample-preview
// ---------------------------------------------------------------------------

export const SamplePreviewQuerySchema = z.object({
  idx: z.coerce.number().int().min(0).default(0),
});

export const SamplePreviewResponseSchema = TrainingSampleSchema;

// ---------------------------------------------------------------------------
// POST /ace/training/save-sample
// ---------------------------------------------------------------------------

export const SaveSampleBodySchema = z.object({
  sampleIdx: z.number().int().min(0).default(0),
  caption: z.string().default(''),
  genre: z.string().default(''),
  promptOverride: z.string().nullable().optional(),
  lyrics: z.string().default(''),
  bpm: z.number().nullable().optional(),
  key: z.string().default(''),
  timeSignature: z.string().default(''),
  language: z.string().default('instrumental'),
  instrumental: z.boolean().default(true),
});

export const SaveSampleResponseSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// POST /ace/training/update-settings — ace-step-ui's handler is a no-op
// (`res.json({ success: true })`); kept for the client's settings-save flow
// symmetry, so the panel doesn't special-case "this one save button does
// nothing server-side."
// ---------------------------------------------------------------------------

export const UpdateTrainingSettingsBodySchema = z.record(z.string(), z.unknown());

export const UpdateTrainingSettingsResponseSchema = z.object({
  success: z.boolean(),
});

// ---------------------------------------------------------------------------
// POST /ace/training/start + POST /ace/training/stop + GET /training-status
// ---------------------------------------------------------------------------

export const StartTrainingBodySchema = z.object({
  datasetName: z.string().optional(),
  // Left unset, the route defaults this to `paths.aceDatasetsDir/preprocessed_tensors`
  // (comfy has no ACE-Step source checkout to resolve ace-step-ui's
  // `./datasets/preprocessed_tensors`-style relative default against).
  tensorDir: z.string().optional(),
  rank: z.number().int().positive().default(64),
  alpha: z.number().positive().default(128),
  dropout: z.number().min(0).max(1).default(0.1),
  learningRate: z.number().positive().default(0.0003),
  epochs: z.number().int().positive().default(1000),
  batchSize: z.number().int().positive().default(1),
  gradientAccumulation: z.number().int().positive().default(1),
  saveEvery: z.number().int().positive().default(200),
  shift: z.number().default(3.0),
  seed: z.number().int().default(42),
  outputDir: z.string().optional(),
  resumeCheckpoint: z.string().nullable().optional(),
});

export const StartTrainingResponseSchema = z.object({
  runId: z.string(),
  status: z.string().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const TrainingStatusResponseSchema = z.record(z.string(), z.unknown());

export const StopTrainingResponseSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// POST /ace/training/preprocess-stems + GET /preprocess-stems-status
// (audio-separator-based training-data preprocessing; see
// services/ace/audioSeparator.ts + stemJobs.ts)
// ---------------------------------------------------------------------------

export const PreprocessStemsBodySchema = z.object({
  datasetName: z.string().min(1),
  category: z.string().min(1),
  subType: z.string().nullable().optional(),
  preprocessing: z.object({
    model: z.string().min(1),
    keepStems: z.array(z.string()).optional(),
    chain: z.array(z.string()).optional(),
    extraArgs: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const PreprocessStemsResponseSchema = z.object({
  jobId: z.string(),
  total: z.number(),
  category: z.string(),
  subType: z.string().nullable().optional(),
  outputDatasetName: z.string(),
  outputDir: z.string(),
});

export const PreprocessStemsStatusQuerySchema = z.object({
  jobId: z.string().min(1),
});

export const PreprocessStemsStatusResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  progress: z.number(),
  current: z.number(),
  total: z.number(),
  log: z.array(z.string()),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ---------------------------------------------------------------------------
// GET /ace/training/limits — GPU tier probe (python/get_limits.py)
// ---------------------------------------------------------------------------

export const TrainingLimitsResponseSchema = z.object({
  tier: z.string(),
  gpu_memory_gb: z.number(),
  max_duration_with_lm: z.number(),
  max_duration_without_lm: z.number(),
  max_batch_size_with_lm: z.number(),
  max_batch_size_without_lm: z.number(),
});
