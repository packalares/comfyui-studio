// Shared contract types + Zod schemas for the Videoboard feature.
// TS interfaces are derived from Zod schemas (z.infer) — single source of truth.

import { z } from 'zod';

// ---- Settings ----------------------------------------------------------------

export const ProjectSettingsSchema = z.object({
  fixedShotSeconds: z.number().default(10),
  styleHint: z.string().default(''),
  imageTemplateName: z.string().default('image_flux2_text_to_image_9b'),
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  videoTemplateName: z.string().optional(),
  videoFps: z.number().int().positive().optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

// ---- Shot --------------------------------------------------------------------

export const ShotStatusSchema = z.enum(['pending', 'queued', 'generating', 'ready', 'error']);

export const ShotSchema = z.object({
  idx: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  lyrics: z.string(),
  prompt: z.string(),
  seed: z.number().int(),
  imageUrl: z.string().optional(),
  videoUrl: z.string().optional(),
  status: ShotStatusSchema,
  imagePrompt: z.string().optional(),
  videoPrompt: z.string().optional(),
  keyVisual: z.string().optional(),
  treatmentSnapshot: z.string().optional(),
  chunkIdx: z.number().int().nonnegative().optional(),
  imageTemplateName: z.string().optional(),
  imagePromptId: z.string().optional(),
  savedLatentFilename: z.string().optional(),
});
export type Shot = z.infer<typeof ShotSchema>;

// ---- Project -----------------------------------------------------------------

export const ProjectStatusSchema = z.enum(['draft', 'generating', 'ready', 'error']);
export const AnalysisStatusSchema = z.enum(['none', 'pending', 'ready', 'error']);

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  audioPath: z.string().optional(),
  audioDurationMs: z.number().int().nonnegative().optional(),
  analysisStatus: AnalysisStatusSchema,
  characterIds: z.array(z.string()),
  shots: z.array(ShotSchema),
  settings: ProjectSettingsSchema,
  status: ProjectStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---- Analysis ----------------------------------------------------------------

export const AudioMetaSchema = z.object({
  format: z.string().nullable(),
  size_bytes: z.number().nullable(),
  bitrate_kbps: z.number().nullable(),
  channels: z.number().nullable(),
  sample_rate: z.number().nullable(),
});
export type AudioMeta = z.infer<typeof AudioMetaSchema>;

export const TempoTagSchema = z.enum(['Slow', 'Mid', 'Upbeat', 'Fast']);
export type TempoTag = z.infer<typeof TempoTagSchema>;

export const AnalysisSchema = z.object({
  identifier: z.string(),
  duration: z.number(),
  duration_ms: z.number(),
  bpm: z.number(),
  bpm_min: z.number().nullable(),
  bpm_max: z.number().nullable(),
  tempo_tag: TempoTagSchema.nullable(),
  time_signature: z.string().nullable(),
  keyscale: z.string(),
  language: z.string().nullable(),
  lang_code: z.string().nullable(),
  audio_meta: AudioMetaSchema,
  lyrics: z.string().nullable(),
  genre: z.string().nullable(),
  style: z.string().nullable(),
  short_description: z.string().nullable(),
  full_description: z.string().nullable(),
  mood: z.string().nullable(),
  keywords: z.array(z.string()).nullable(),
  instruments: z.array(z.string()).nullable(),
  vocals: z.string().nullable(),
  era_feel: z.string().nullable(),
  narrative_arc: z.string().nullable(),
  subject: z.string().nullable(),
  color_palette: z.array(z.string()).nullable(),
  setting_hint: z.string().nullable(),
  caption_raw: z.string().nullable(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---- Character ---------------------------------------------------------------

export const CharacterKindSchema = z.enum(['pulid', 'lora']);
export const CharacterBaseModelSchema = z.enum(['flux2-klein', 'flux1-dev', 'sdxl']);

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: CharacterKindSchema,
  baseModel: CharacterBaseModelSchema,
  refPhotoUrls: z.array(z.string()),
  pulidEmbedPath: z.string().optional(),
  loraPath: z.string().optional(),
  createdAt: z.number().int(),
});
export type Character = z.infer<typeof CharacterSchema>;

// ---- Job ---------------------------------------------------------------------

export const JobKindSchema = z.enum(['analyze', 'storyboard', 'image', 'video', 'render', 'train-lora']);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum(['queued', 'running', 'done', 'error']);

export const JobRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  shotIdx: z.number().int().nonnegative().optional(),
  kind: JobKindSchema,
  status: JobStatusSchema,
  progress: z.number().min(0).max(1),
  message: z.string().optional(),
  outputUrl: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

// ---- Route body schemas (shared across server routes) -----------------------

export const CreateProjectBodySchema = z.object({
  name: z.string().default('Untitled'),
});

export const UpdateProjectBodySchema = z.object({
  name: z.string().optional(),
  settings: ProjectSettingsSchema.partial().optional(),
  status: ProjectStatusSchema.optional(),
  characterIds: z.array(z.string()).optional(),
}).partial();

export const UpdateShotBodySchema = ShotSchema.partial().omit({ idx: true });

export const GenerateImageBodySchema = z.object({
  templateName: z.string().optional(),
});

export const GenerateAllImagesBodySchema = z.object({
  templateName: z.string().optional(),
});

export const AnimateShotBodySchema = z.object({
  templateName: z.string().optional(),
});

export const GenerateAllVideosBodySchema = z.object({
  templateName: z.string().optional(),
});

export const GenerateChainBodySchema = z.object({
  startIdx: z.number().int().nonnegative().optional(),
  stopIdx: z.number().int().nonnegative().optional(),
  startingImageUrl: z.string().optional(),
  templateName: z.string().optional(),
});

export const GenerateStoryboardBodySchema = z.object({});

// ---- Common response schemas -------------------------------------------------

export const JobStartedSchema = z.object({ jobId: z.string() });
export type JobStarted = z.infer<typeof JobStartedSchema>;

export const OkSchema = z.object({ ok: z.literal(true) });
export const AudioPathSchema = z.object({ audioPath: z.string() });

export const GenerateAllResponseSchema = z.object({
  queued: z.array(z.number().int()),
  skipped: z.number().int(),
  message: z.string().optional(),
});

export const ChainStartedSchema = z.object({
  jobId: z.string(),
  startIdx: z.number().int(),
  stopIdx: z.number().int(),
  shotCount: z.number().int(),
});
