// Zod schemas for the ACE-Step music generation routes:
// POST /api/ace/generate, GET /api/ace/generate/status/:jobId,
// GET /api/ace/generate/models, POST /api/ace/generate/simple,
// GET /api/ace/generate/random-description, POST /api/ace/generate/format,
// POST /api/ace/generate/upload-audio.

import { z } from 'zod';

export const GenerationParamsSchema = z.object({
  customMode: z.boolean(),
  songDescription: z.string().optional(),
  lyrics: z.string().default(''),
  style: z.string().default(''),
  title: z.string().default(''),
  instrumental: z.boolean().default(false),
  vocalLanguage: z.string().optional(),
  duration: z.number().optional(),
  bpm: z.number().optional(),
  keyScale: z.string().optional(),
  timeSignature: z.string().optional(),
  inferenceSteps: z.number().int().positive().optional(),
  guidanceScale: z.number().optional(),
  batchSize: z.number().int().min(1).max(16).optional(),
  randomSeed: z.boolean().optional(),
  seed: z.number().int().optional(),
  thinking: z.boolean().optional(),
  enhance: z.boolean().optional(),
  audioFormat: z.enum(['mp3', 'flac', 'wav32']).optional(),
  inferMethod: z.enum(['ode', 'sde']).optional(),
  shift: z.number().optional(),
  lmTemperature: z.number().optional(),
  lmCfgScale: z.number().optional(),
  lmTopK: z.number().int().optional(),
  lmTopP: z.number().optional(),
  lmNegativePrompt: z.string().optional(),
  referenceAudioUrl: z.string().optional(),
  sourceAudioUrl: z.string().optional(),
  audioCodes: z.string().optional(),
  repaintingStart: z.number().optional(),
  repaintingEnd: z.number().optional(),
  instruction: z.string().optional(),
  audioCoverStrength: z.number().optional(),
  coverNoiseStrength: z.number().optional(),
  taskType: z.string().optional(),
  useAdg: z.boolean().optional(),
  cfgIntervalStart: z.number().optional(),
  cfgIntervalEnd: z.number().optional(),
  customTimesteps: z.string().optional(),
  useCotMetas: z.boolean().optional(),
  useCotCaption: z.boolean().optional(),
  useCotLanguage: z.boolean().optional(),
  autogen: z.boolean().optional(),
  constrainedDecodingDebug: z.boolean().optional(),
  allowLmBatch: z.boolean().optional(),
  getScores: z.boolean().optional(),
  getLrc: z.boolean().optional(),
  scoreScale: z.number().optional(),
  lmBatchChunkSize: z.number().int().optional(),
  trackName: z.string().optional(),
  completeTrackClasses: z.array(z.string()).optional(),
  isFormatCaption: z.boolean().optional(),
  ditModel: z.string().optional(),
  repaintMode: z.string().optional(),
  repaintStrength: z.number().optional(),
  enableNormalization: z.boolean().optional(),
  normalizationDb: z.number().optional(),
  fadeInDuration: z.number().optional(),
  fadeOutDuration: z.number().optional(),
  mp3Bitrate: z.string().optional(),
  mp3SampleRate: z.number().int().optional(),
});
export type GenerationParamsInput = z.infer<typeof GenerationParamsSchema>;

export const GenerateSubmitResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'running']),
  taskId: z.string().nullable(),
});

export const GenerationResultSchema = z.object({
  audioUrls: z.array(z.string()),
  duration: z.number(),
  bpm: z.number().optional(),
  keyScale: z.string().optional(),
  timeSignature: z.string().optional(),
  status: z.string(),
});

export const GenerationStatusParamsSchema = z.object({
  jobId: z.string().min(1),
});

export const GenerationStatusResponseSchema = z.object({
  jobId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  queuePosition: z.number().optional(),
  etaSeconds: z.number().optional(),
  progress: z.number().optional(),
  stage: z.string().optional(),
  result: GenerationResultSchema.nullable().optional(),
  error: z.string().nullable().optional(),
});

export const ModelInfoSchema = z.object({
  name: z.string(),
  is_active: z.boolean(),
  is_preloaded: z.boolean(),
});

export const ModelsListResponseSchema = z.object({
  models: z.array(ModelInfoSchema),
});

export const SimpleGenerateBodySchema = z.object({
  description: z.string().optional(),
  genre: z.string().optional(),
  instrumental: z.boolean().optional(),
});

export const SimpleGenerateResponseSchema = z.object({
  caption: z.string(),
  lyrics: z.string(),
  language: z.string(),
});

export const RandomDescriptionQuerySchema = z.object({
  lang: z.string().optional(),
});

export const RandomDescriptionResponseSchema = z.object({
  description: z.string(),
  instrumental: z.boolean(),
  vocalLanguage: z.string(),
});

export const FormatBodySchema = z.object({
  caption: z.string().min(1),
  lyrics: z.string().optional(),
  bpm: z.number().optional(),
  duration: z.number().optional(),
  keyScale: z.string().optional(),
  timeSignature: z.string().optional(),
  temperature: z.number().optional(),
});

export const FormatResponseSchema = z.object({
  caption: z.string(),
  lyrics: z.string(),
  bpm: z.number().optional(),
  duration: z.number().optional(),
  key_scale: z.string().optional(),
  time_signature: z.string().optional(),
  vocal_language: z.string().optional(),
});

export const UploadAudioResponseSchema = z.object({
  url: z.string(),
  key: z.string(),
});

export const AudioParamsSchema = z.object({
  kind: z.enum(['output', 'reference']),
  key: z.string().min(1),
});
