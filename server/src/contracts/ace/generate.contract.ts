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
  /**
   * ACE-Step's semantic fingerprint of a song — the LM's compressed
   * "understanding" of the music, as a `<|audio_code_N|>` token string, NOT a
   * waveform. Passing it alongside a prompt is a far stronger "sound like
   * this" than any text description, because the model receives the actual
   * musical structure instead of words about it. Produced by `POST
   * /ace/analyze` (see `extractCodesOnly`).
   */
  audioCodes: z.string().optional(),
  /**
   * Run the analysis path instead of generating: encode `sourceAudioUrl` to
   * audio codes and return them without producing audio. Cheap next to a real
   * generation — a VAE encode plus a tokenize, no diffusion loop.
   */
  extractCodesOnly: z.boolean().optional(),
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

/**
 * POST /ace/analyze — "sound like this" style capture.
 *
 * Synchronous, unlike generation: extracting codes is a VAE encode plus a
 * tokenize with no diffusion loop, so it finishes in seconds and the client
 * can just await it rather than poll a job row. Nothing is written to the
 * songs table — this produces no audio.
 */
export const AnalyzeBodySchema = z.object({
  sourceAudioUrl: z.string().min(1),
  ditModel: z.string().optional(),
});

export const AnalyzeResponseSchema = z.object({
  /** `<|audio_code_N|>` token string, fed back as `audioCodes` on generate. */
  audioCodes: z.string(),
  /** How many tokens came back — the only cheap signal that the capture is
   *  substantive rather than a near-empty encode of a silent clip. */
  codeCount: z.number(),
  /**
   * The LM's reading of the track, when the deep pass succeeded. Absent when
   * only codes could be extracted — the style transfer still works in that
   * case, we just can't say in words what was captured, so the UI must treat
   * every field here as optional rather than assume a readout exists.
   */
  bpm: z.number().optional(),
  keyScale: z.string().optional(),
  timeSignature: z.string().optional(),
  duration: z.number().optional(),
  genre: z.string().optional(),
  caption: z.string().optional(),
  lyrics: z.string().optional(),
  language: z.string().optional(),
});

/**
 * POST /ace/stems — real stem separation (Roformer/Demucs), NOT the model's
 * generative `extract` task. This isolates what's actually in the recording;
 * `extract` re-synthesises an approximation of it. Different tools, and the
 * distinction matters when someone asks for "the drums from this song".
 */
export const StemsBodySchema = z.object({
  sourceAudioUrl: z.string().min(1),
  /** audio-separator checkpoint. Defaults to the 6-stem Demucs model, which is
   *  the only one that yields drums/bass/guitar/piano separately. */
  model: z.string().optional(),
});

export const StemsResponseSchema = z.object({
  stems: z.array(z.object({
    name: z.string(),
    url: z.string(),
  })),
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
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  queuePosition: z.number().optional(),
  etaSeconds: z.number().optional(),
  progress: z.number().optional(),
  stage: z.string().optional(),
  result: GenerationResultSchema.nullable().optional(),
  error: z.string().nullable().optional(),
});

// ---- POST /ace/generate/cancel/:jobId ----

export const GenerationCancelParamsSchema = z.object({
  jobId: z.string().min(1),
});

export const GenerationCancelResponseSchema = z.object({
  jobId: z.string(),
  cancelled: z.boolean(),
});

export const ModelInfoSchema = z.object({
  name: z.string(),
  is_active: z.boolean(),
  is_preloaded: z.boolean(),
  /** The registry's `default: true` checkpoint — the one meant for ordinary
   *  generation. Exposed so the client can preselect it instead of falling
   *  back to alphabetical order, which picks `xl-base` (a fine-tuning
   *  starting point that produces markedly worse songs). */
  is_default: z.boolean(),
  /**
   * The checkpoint's OWN `config.json` `is_turbo` flag — the same value
   * ACE-Step reads in `api/http/model_service_routes.py:_read_model_supported_tasks`
   * to decide which task types a model accepts (`TASK_TYPES_TURBO` when true,
   * the full `TASK_TYPES_BASE` when false).
   *
   * Exposed because the client previously inferred this from the checkpoint
   * NAME (`/(^|[-_])base($|[-_])/`), which is wrong for a real, shipped model:
   * `acestep-v15-xl-sft` has `is_turbo: false`, so ACE-Step grants it
   * Extract/Lego/Complete — but the name doesn't contain "base", so the UI hid
   * those three modes. Null when the config is missing/unreadable, which the
   * client treats as "assume turbo" (hide the base-only modes) — the safe
   * direction, since offering a mode the model can't run fails opaquely inside
   * ACE-Step.
   */
  is_turbo: z.boolean().nullable(),
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

// ---- GPU residency / idle-unload (services/gpu/scheduler.ts + residency.ts) ----

export const GpuStatusResponseSchema = z.object({
  /** Whether the ACE-Step FastAPI child process is currently alive. */
  running: z.boolean(),
  /** Which tenant currently holds the GPU scheduler slot — see
   *  `services/gpu/taskTypes.ts`'s `GpuTenant`. */
  tenant: z.enum(['ollama', 'comfy', 'ace-step', 'oneshot', 'none']),
  /** Minutes the scheduler has been idle on the `ace-step` tenant, or `null`
   *  when `ace-step` isn't the currently-resident tenant / a job is active. */
  idleMinutes: z.number().nullable(),
  /** Configured idle-evict timeout in minutes for `ace-step` (runtime
   *  override if set via `POST .../gpu/auto-unload`, else the
   *  `ACE_STEP_IDLE_EVICT_MS` env default), or `null` when disabled. */
  timeoutMinutes: z.number().nullable(),
});

export const AutoUnloadBodySchema = z.object({
  /** 0 disables idle-eviction for `ace-step`; otherwise the new timeout in
   *  minutes (clamped 1-480). Omit/`null` to revert to the env default. */
  minutes: z.number().int().min(0).max(480).nullable(),
});

export const AudioParamsSchema = z.object({
  // Generated song output is served through the gallery's `/api/view` now —
  // only user-uploaded reference/source audio streams through this route.
  kind: z.enum(['reference']),
  key: z.string().min(1),
});
