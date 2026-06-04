// Shared contract types for the Videoboard (music-video maker) feature.
// All agents reference this file as the source of truth — copy verbatim.

// Only fields the Director (OMNI_AUDIO_VideoScenes) actually consumes today.
// Removed: shotMode/bpmBarsPerShot (BPM mode not yet implemented — TODO.md §2a),
// snapToLyrics/snapToSections (blocked on Whisper — TODO.md §2b/2c),
// llmModel (Director uses GGUF subprocess, not Ollama). Add fields back when
// the corresponding plumbing lands.
export interface ProjectSettings {
  fixedShotSeconds: number          // default 10 — matches the Director node's widget default
  styleHint: string                 // free-form direction (palette, era, references); '' = director's discretion
  imageTemplateName: string         // Studio template used for shot image gen (filename in user-workflows/, no .json). default 'image_flux2_text_to_image_9b'.
  imageWidth?: number               // output image width for shot image gen; undefined = use template default
  imageHeight?: number              // output image height for shot image gen; undefined = use template default
  videoTemplateName?: string        // Studio template used for shot video gen. default 'video_ltx2_3_flf2v'.
  videoFps?: number                 // target fps for video gen (drives frame count from shot duration); default 25 (LTX-2.3 native)
}

export interface Shot {
  idx: number
  startMs: number
  endMs: number
  lyrics: string
  prompt: string
  seed: number
  imageUrl?: string
  videoUrl?: string
  status: 'pending' | 'queued' | 'generating' | 'ready' | 'error'
  // Director output (populated when shots come from OMNI_AUDIO_VideoScenes).
  // All optional so mock/legacy rows still validate.
  imagePrompt?: string              // 60-100 word still-image prompt (6-slot formula)
  videoPrompt?: string              // 70-120 word i2v prompt (Wan/LTX formula)
  keyVisual?: string                // one-line composition tag
  treatmentSnapshot?: string        // rolling treatment AS the model saw it for this shot
  chunkIdx?: number                 // which 30s audio chunk produced this shot
  imageTemplateName?: string        // per-shot override for the Studio image template; falls back to project.settings.imageTemplateName
  imagePromptId?: string            // last submitted ComfyUI prompt_id for this shot's image — useful for traceback / cancellation
  // LTX latent-chain mode: file produced by SaveLatent for THIS shot's final
  // AV latent. The next shot's run loads this via LoadLatent → switch.input1
  // and skips the image branch + base sampler entirely. Filename only (no
  // subfolder) because SaveLatent + LoadLatent operate on ComfyUI's output
  // root. Optional — only populated when the shot was generated via the
  // chain pipeline; FLF2V shots leave it undefined.
  savedLatentFilename?: string
}

export interface Project {
  id: string
  name: string
  audioPath?: string
  audioDurationMs?: number
  analysisStatus: 'none' | 'pending' | 'ready' | 'error'
  characterIds: string[]
  shots: Shot[]
  settings: ProjectSettings
  status: 'draft' | 'generating' | 'ready' | 'error'
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Analysis — produced by OMNI_AUDIO_Analyze in ComfyUI and stored verbatim
// as a JSON blob. Field names are snake_case because this shape IS the
// analyzer's output; no mapping layer between the node and the DB.
// ---------------------------------------------------------------------------

export interface AudioMeta {
  format: string | null;            // 'mp3' | 'wav' | … (ffprobe), null without audio_source_path
  size_bytes: number | null;
  bitrate_kbps: number | null;
  channels: number | null;          // always populated (tensor-derived fallback)
  sample_rate: number | null;       // always populated (tensor-derived fallback)
}

export type TempoTag = 'Slow' | 'Mid' | 'Upbeat' | 'Fast';

export interface Analysis {
  identifier: string;               // typically project.id; auto-generated 8-char hex if blank
  duration: number;                 // seconds
  duration_ms: number;

  // rhythm
  bpm: number;
  bpm_min: number | null;
  bpm_max: number | null;
  tempo_tag: TempoTag | null;
  time_signature: string | null;    // '2/4' | '3/4' | '4/4' | '6/8' | null

  keyscale: string;                 // 'C major', 'A minor', …

  language: string | null;          // full name, from caption (e.g. 'Romanian')
  lang_code: string | null;         // ISO short code, from transcriber header (e.g. 'ro')

  audio_meta: AudioMeta;

  // Lyrics — single string from the Transcriber with section labels
  // preserved inline ([Verse 1], [Chorus], …). The `# Languages\n<code>\n# Lyrics`
  // markdown header is stripped before storage; the code lives in `lang_code`.
  // No per-line timestamps (the model doesn't produce real ones).
  lyrics: string | null;

  // captioner output, flattened to root (null when caption disabled or field missing)
  genre: string | null;
  style: string | null;
  short_description: string | null;
  full_description: string | null;
  mood: string | null;
  keywords: string[] | null;
  instruments: string[] | null;
  vocals: string | null;
  era_feel: string | null;
  narrative_arc: string | null;
  subject: string | null;
  color_palette: string[] | null;
  setting_hint: string | null;

  caption_raw: string | null;       // Set only when the captioner returned non-JSON.
}

export interface Character {
  id: string
  name: string
  kind: 'pulid' | 'lora'
  baseModel: 'flux2-klein' | 'flux1-dev' | 'sdxl'
  refPhotoUrls: string[]
  pulidEmbedPath?: string
  loraPath?: string
  createdAt: number
}

export type JobKind = 'analyze' | 'storyboard' | 'image' | 'video' | 'render' | 'train-lora'
export interface JobRecord {
  id: string
  projectId: string
  shotIdx?: number
  kind: JobKind
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number              // 0..1
  message?: string
  outputUrl?: string
  createdAt: number
  updatedAt: number
}
