// Types for the ACE-Step music page (`pages/music/*`). Mirrors the Zod
// schemas in `server/src/contracts/ace/{generate,songs,lyrics}.contract.ts` —
// kept as plain TS interfaces (rather than importing `z.infer<...>` types)
// so this file has zero runtime dependency on the server package, matching
// how the rest of `ui/src/types` is authored.
//
// EXCEPTION: `GenerationParams` is derived from the contract via `import
// type`, which emits nothing and so preserves that property. See the comment
// on it — hand-mirroring that particular shape caused real, silent bugs.

import type { z } from 'zod';
import type { GenerationParamsSchema } from '@server/contracts/ace/generate.contract';

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type AudioFormat = 'mp3' | 'flac' | 'wav32';
export type InferMethod = 'ode' | 'sde';

/**
 * Body of `POST /api/ace/generate` — DERIVED from the server contract, never
 * hand-maintained.
 *
 * This was previously a hand-written interface listing "only the fields the
 * Create tab actually drives". That drifted, silently, and it was the root
 * cause of a whole class of bug: `trackName` and `completeTrackClasses` were
 * missing here, so Extract/Lego/Continue could not send the structured values
 * ACE-Step actually reads, and nothing failed to compile. The mismatch was
 * invisible because `services/ace.ts` cast the body
 * (`params as z.infer<typeof GenerationParamsSchema>`) on the way out, which
 * threw away the one check that would have caught it.
 *
 * Deriving it means the compiler now enforces both directions: a field the
 * contract accepts is automatically visible to the UI, and a field the UI
 * invents is an error rather than a request key ACE-Step silently drops.
 *
 * `import type` keeps this file free of any runtime dependency on the server
 * package, which is the property the header above cares about — that rule was
 * about emitted code, not about type identity.
 */
export type GenerationParams = z.infer<typeof GenerationParamsSchema>;

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GenerateSubmitResponse {
  jobId: string;
  status: 'queued' | 'running';
  taskId: string | null;
}

export interface GenerationResult {
  audioUrls: string[];
  duration: number;
  bpm?: number;
  keyScale?: string;
  timeSignature?: string;
  status: string;
}

export interface GenerationStatusResponse {
  jobId: string;
  status: GenerationJobStatus;
  queuePosition?: number;
  etaSeconds?: number;
  progress?: number;
  stage?: string;
  result?: GenerationResult | null;
  error?: string | null;
}

export interface AceModelInfo {
  name: string;
  is_active: boolean;
  is_preloaded: boolean;
  /** Registry's `default: true` checkpoint (xl-turbo) — preselected ahead of
   *  alphabetical order, which would otherwise pick xl-base. */
  is_default: boolean;
  /** The checkpoint's own `config.json` `is_turbo` flag, as ACE-Step reads it.
   *  Null when unreadable. Drives which generation modes are offered — see
   *  `pages/music/generationModes.ts`. */
  is_turbo: boolean | null;
}

export interface SimpleGenerateResult {
  caption: string;
  lyrics: string;
  language: string;
}

export interface RandomDescriptionResult {
  description: string;
  instrumental: boolean;
  vocalLanguage: string;
}

export interface FormatResult {
  caption: string;
  lyrics: string;
  bpm?: number;
  duration?: number;
  key_scale?: string;
  time_signature?: string;
  vocal_language?: string;
}

export interface UploadAudioResult {
  url: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Songs / playlists (local library)
// ---------------------------------------------------------------------------

export interface Song {
  id: string;
  /** Owning gallery row — artwork comes from `/api/thumbnail/<galleryId>`.
   *  See `SongArtwork`. */
  galleryId: string;
  title: string;
  lyrics: string | null;
  style: string | null;
  caption: string | null;
  coverUrl: string | null;
  audioUrl: string | null;
  duration: number | null;
  bpm: number | null;
  keyScale: string | null;
  timeSignature: string | null;
  tags: string[];
  favorite: boolean;
  generationParams: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface SongListQuery {
  favorite?: boolean;
  limit?: number;
  offset?: number;
}

export interface SongUpdateBody {
  title?: string;
  lyrics?: string | null;
  style?: string | null;
  caption?: string | null;
  coverUrl?: string | null;
  tags?: string[];
}

export interface Playlist {
  id: string;
  name: string;
  description: string | null;
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export interface LyricsGenerateBody {
  genre?: string;
  language?: string;
  topic?: string;
  mood?: string;
  structure?: string;
  modelId?: string;
}

// ---------------------------------------------------------------------------
// Player / queue (client-side only — not part of the wire contract)
// ---------------------------------------------------------------------------

export type RepeatMode = 'none' | 'all' | 'one';

// ---------------------------------------------------------------------------
// Training (LoRA / voice-clone) — mirrors
// `server/src/contracts/ace/training.contract.ts`.
// ---------------------------------------------------------------------------

export interface TrainingSample {
  index?: number;
  audio?: string | null;
  filename: string;
  caption: string;
  genre: string;
  promptOverride?: string | null;
  lyrics: string;
  bpm?: number | null;
  key: string;
  timeSignature: string;
  duration: number;
  language: string;
  instrumental: boolean;
  rawLyrics: string;
}

export type TagPositionWire = 'prepend' | 'append';

export interface TrainingDatasetSettings {
  datasetName: string;
  customTag: string;
  tagPosition: string;
  allInstrumental: boolean;
  genreRatio: number;
}

export interface DatasetBuildResult {
  status: string;
  dataframe?: unknown;
  sampleCount: number;
  sample: TrainingSample | null;
  settings: TrainingDatasetSettings;
  datasetPath: string;
}

export interface UploadTrainingAudioResult {
  files: { filename: string; originalName: string; size: number; path: string }[];
  uploadDir: string;
  count: number;
}

export interface BuildDatasetBody {
  datasetName: string;
  customTag?: string;
  tagPosition?: TagPositionWire;
  allInstrumental?: boolean;
}

export interface PreprocessBody {
  datasetPath: string;
  outputDir?: string;
}

export interface AutoLabelBody {
  skipMetas?: boolean;
  formatLyrics?: boolean;
  transcribeLyrics?: boolean;
  onlyUnlabeled?: boolean;
}

export interface InitModelBody {
  checkpoint?: string;
  initLlm?: boolean;
  lmModelPath?: string;
  reinitialize?: boolean;
}

export interface SaveSampleBody {
  sampleIdx: number;
  caption?: string;
  genre?: string;
  promptOverride?: string | null;
  lyrics?: string;
  bpm?: number | null;
  key?: string;
  timeSignature?: string;
  language?: string;
  instrumental?: boolean;
}

export interface StartTrainingBody {
  datasetName?: string;
  tensorDir?: string;
  rank?: number;
  alpha?: number;
  dropout?: number;
  learningRate?: number;
  epochs?: number;
  batchSize?: number;
  gradientAccumulation?: number;
  saveEvery?: number;
  shift?: number;
  seed?: number;
  outputDir?: string;
  resumeCheckpoint?: string | null;
}

export interface StartTrainingResult {
  runId: string;
  status?: string;
  raw?: Record<string, unknown>;
}

export interface PreprocessStemsBody {
  datasetName: string;
  category: string;
  subType?: string | null;
  preprocessing: {
    model: string;
    keepStems?: string[];
    chain?: string[];
    extraArgs?: Record<string, unknown>;
  };
}

export interface PreprocessStemsResult {
  jobId: string;
  total: number;
  category: string;
  subType?: string | null;
  outputDatasetName: string;
  outputDir: string;
}

export interface PreprocessStemsStatus {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  current: number;
  total: number;
  log: string[];
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TrainingLimits {
  tier: string;
  gpu_memory_gb: number;
  max_duration_with_lm: number;
  max_duration_without_lm: number;
  max_batch_size_with_lm: number;
  max_batch_size_without_lm: number;
}

// ---------------------------------------------------------------------------
// TTS (voice-clone speech synthesis) — mirrors
// `server/src/contracts/ace/tts.contract.ts`.
// ---------------------------------------------------------------------------

export interface TtsJobResult {
  audioUrl: string;
  durationSeconds: number;
}

export interface TtsStatus {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  log: string[];
  result?: TtsJobResult | null;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TtsCloneBody {
  refAudio: File;
  text: string;
  emoAudio?: File;
  emoAlpha?: number;
  emoText?: string;
  emoVector?: number[];
  fp16?: boolean;
  seed?: number;
  intervalSilence?: number;
}

// ---------------------------------------------------------------------------
// LoRA control — mirrors `server/src/contracts/ace/lora.contract.ts`.
// ---------------------------------------------------------------------------

export interface LoraLoadResult {
  message: string;
  lora_path: string;
  loaded: boolean;
}

export interface LoraStatus {
  loaded: boolean;
  active: boolean;
  scale: number;
}
