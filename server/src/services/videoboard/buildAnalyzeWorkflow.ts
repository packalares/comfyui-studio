/**
 * Programmatic ComfyUI graph for the Music Analyze pipeline.
 *
 * Builds the minimal two-node prompt that runs OMNI_AUDIO_Analyze on an
 * absolute audio path. The returned object is the body POSTed to ComfyUI's
 * /prompt endpoint as `{ prompt: <graph>, client_id: <uuid> }`.
 *
 *   "1" OMNI_AUDIO_LoadAudioPath   (absolute path → AUDIO dict)
 *        ↓
 *   "2" OMNI_AUDIO_Analyze         (AUDIO + path → analysis_json + 6 ports)
 *
 * DEFAULT_PROMPT_* constants below mirror the Python defaults in
 * apps/custom_nodes/comfyui-studio-omni-audio/nodes_analyze.py — they MUST
 * stay in sync with that file. Callers may override any prompt per-project
 * (e.g. user-edited prompts persisted on the videoboard project row).
 */

export type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

export type ComfyPromptGraph = Record<string, ComfyNode>;

// Captioner model names. Hardcoded because only one Omni-audio GGUF pair lives
// in models/llm_gguf/ on this stack — the Analyze node's dropdown filter
// surfaces exactly these two files. Callers can override per-call if a future
// stack ships different weights.
export const DEFAULT_CAPTIONER_GGUF = 'Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf';
export const DEFAULT_CAPTIONER_MMPROJ = 'mmproj-Qwen3-Omni-30B-A3B-Instruct-Q8_0.gguf';
export const DEFAULT_TRANSCRIBER_MODEL = 'acestep-transcriber';

export interface AnalyzeWorkflowParams {
  /** Absolute filesystem path to the source audio, readable by the ComfyUI process. */
  audioPath: string;
  /** Stored verbatim in analysis_json.identifier — typically project.id. */
  identifier: string;

  // Model overrides. Default to the constants above when omitted.
  captionerGguf?: string;
  captionerMmproj?: string;
  transcriberModel?: string;

  // Phase toggles — match the node defaults when omitted.
  lyricsEnabled?: boolean;
  captionEnabled?: boolean;

  // Per-prompt overrides. When omitted, the DEFAULT_PROMPT_* constants below
  // are sent, NOT the Python node's `default=` (the workflow JSON must carry
  // a concrete value for every required widget).
  promptTranscribe?: string;
  promptCaption?: string;

  // Advanced.
  chunkLengthS?: number;
  temperature?: number;
  ctxSize?: number;
  maxTokensCaption?: number;
}

// ---------------------------------------------------------------------------
// Default prompts — MIRRORED from nodes_analyze.py. Keep them byte-identical
// or override them per-call; don't drift these silently.
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_TRANSCRIBE =
  'Transcribe the sung lyrics of this audio. Include section labels '
  + '(e.g. [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro]) '
  + 'on their own line before each section. Detect the sung language '
  + 'automatically. Do not add commentary or descriptions outside the lyrics.';

export const DEFAULT_PROMPT_CAPTION = `Listen to this audio carefully and return ONLY a JSON object with EVERY
field below populated. Use double quotes. Be specific — name actual
instruments and concrete imagery, never vague labels like 'percussion'.

{
  "language": "<full language name in English, e.g. 'Romanian', 'English', 'Brazilian Portuguese'>",
  "genre": "<primary genre + sub-genre>",
  "style": "<production aesthetic / era / regional flavor>",
  "short_description": "<one sentence summary>",
  "full_description": "<a detailed 4-6 sentence music-director-style paragraph covering: tempo + key + structure (with rough [mm:ss] section markers), each instrument and how it's played, lead + backing vocals, production / mix character, lyrical themes (quote 2-3 memorable lines verbatim), and the mood arc from intro to outro>",
  "mood": "<single descriptor word or short phrase, e.g. 'melancholic', 'euphoric', 'tense'>",
  "keywords": ["<5 to 8 short keywords describing the song's vibe — single words or short phrases>"],
  "instruments": ["<each distinct instrument you can hear, named specifically>"],
  "vocals": "<vocalist description: register + timbre + delivery, e.g. 'single female alto, intimate close-mic, breathy'>",
  "era_feel": "<implied era / decade vibe, e.g. 'late-2000s indie', '1970s funk', 'contemporary'>",
  "narrative_arc": "<how the song's intensity evolves, e.g. 'slow build, release in final chorus'>",
  "subject": "<what the song is about, one short clause>",
  "color_palette": ["<3 to 5 visual colors the music evokes>"],
  "setting_hint": "<implied physical setting/location the song calls to mind>"
}

Do NOT include anything outside the JSON. Every field is REQUIRED.`;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the /prompt graph for one Analyze run.
 *
 * Caller responsibilities:
 *   - `audioPath` must be readable by the ComfyUI process (same pod, mounted
 *     volume, or a path under ComfyUI's working dir).
 *   - The two GGUF filenames must exist under models/llm_gguf/ on the
 *     ComfyUI side. The Analyze node otherwise rejects them.
 */
export function buildAnalyzeWorkflow(p: AnalyzeWorkflowParams): ComfyPromptGraph {
  return {
    '1': {
      class_type: 'OMNI_AUDIO_LoadAudioPath',
      inputs: { path: p.audioPath },
    },
    '2': {
      class_type: 'OMNI_AUDIO_Analyze',
      inputs: {
        audio: ['1', 0],
        identifier: p.identifier,
        transcriber_model: p.transcriberModel ?? DEFAULT_TRANSCRIBER_MODEL,
        captioner_gguf: p.captionerGguf ?? DEFAULT_CAPTIONER_GGUF,
        captioner_mmproj: p.captionerMmproj ?? DEFAULT_CAPTIONER_MMPROJ,
        lyrics_enabled: p.lyricsEnabled ?? true,
        caption_enabled: p.captionEnabled ?? true,
        chunk_length_s: p.chunkLengthS ?? 450.0,
        prompt_transcribe: p.promptTranscribe ?? DEFAULT_PROMPT_TRANSCRIBE,
        prompt_caption: p.promptCaption ?? DEFAULT_PROMPT_CAPTION,
        audio_source_path: p.audioPath,
        device: 'auto',
        dtype: 'auto',
        temperature: p.temperature ?? 0.2,
        max_tokens_caption: p.maxTokensCaption ?? 2500,
        ctx_size: p.ctxSize ?? 16384,
      },
    },
  };
}
