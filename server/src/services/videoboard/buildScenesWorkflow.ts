/**
 * Programmatic ComfyUI graph for the Video Scenes (Director) pipeline.
 *
 * Builds a two-node prompt that runs OMNI_AUDIO_VideoScenes on the same audio
 * the Analyze pass already consumed, plus the analysis JSON the user just got
 * back. The returned object is POSTed to ComfyUI's /prompt endpoint.
 *
 *   "1" OMNI_AUDIO_LoadAudioPath        (absolute path → AUDIO dict)
 *        ↓
 *   "2" OMNI_AUDIO_VideoScenes          (AUDIO + analysis → scenes_json + treatment)
 *
 * The captioner GGUF pair is shared with Analyze (same model file). Default
 * constants below mirror the Director node's widget defaults — keep them in
 * sync with apps/custom_nodes/comfyui-studio-omni-audio/nodes_video_scenes.py.
 */

import type { ComfyNode, ComfyPromptGraph } from './buildAnalyzeWorkflow.js';
import {
  DEFAULT_CAPTIONER_GGUF,
  DEFAULT_CAPTIONER_MMPROJ,
} from './buildAnalyzeWorkflow.js';

export type { ComfyNode, ComfyPromptGraph };

export interface ScenesWorkflowParams {
  /** Absolute path readable by the ComfyUI process. */
  audioPath: string;
  /** Verbatim analysis JSON the Analyze run produced — the Director re-parses it. */
  analysisJson: string;
  /** Traceability tag — typically project.id. Logged by the node at run start
   *  and surfaced via /history.identifier[0]. Optional. */
  identifier?: string;
  /** Free-form direction (palette, era, references). '' lets the model decide. */
  styleHint?: string;
  /** Target shot length in seconds. The Director picks the closest whole shot
   *  count that divides each 30 s audio chunk evenly. */
  shotSeconds?: number;

  // Captioner overrides. Default to the same pair Analyze uses.
  captionerGguf?: string;
  captionerMmproj?: string;

  // Advanced — only set when overriding the node defaults.
  treatmentTemperature?: number;
  scenesTemperature?: number;
  maxTokensTreatment?: number;
  maxTokensScenes?: number;
  ctxSize?: number;
  audioChunkSeconds?: number;

  // Per-prompt overrides. When omitted, the node's built-in defaults are sent
  // (the node's INPUT_TYPES carry the actual prompt strings as widget defaults,
  // so we don't have to mirror them here — sending '' would blank them).
  promptTreatment?: string;
  promptChunkScenes?: string;
}

export const SCENES_DEFAULT_SHOT_SECONDS = 10.0;
export const SCENES_DEFAULT_TREATMENT_TEMP = 0.65;
export const SCENES_DEFAULT_SCENES_TEMP = 0.65;
export const SCENES_DEFAULT_MAX_TOKENS_TREATMENT = 2400;
export const SCENES_DEFAULT_MAX_TOKENS_SCENES = 8000;
export const SCENES_DEFAULT_CTX_SIZE = 16384;
export const SCENES_DEFAULT_AUDIO_CHUNK_SECONDS = 30.0;

export function buildScenesWorkflow(p: ScenesWorkflowParams): ComfyPromptGraph {
  // Director's required widgets MUST carry concrete values in the workflow
  // JSON — ComfyUI rejects the prompt if a required widget is missing.
  // Optional widgets (audio_chunk_seconds, *_temperature, max_tokens_*,
  // ctx_size) are passed through verbatim when set so power users can dial
  // them per project later, otherwise we omit them and the node falls back
  // to its INPUT_TYPES default.
  // The prompt_* fields are required by INPUT_TYPES, so we MUST send a value
  // (programmatic /api/prompt submission doesn't auto-fill widget defaults).
  // Sending '' makes the Director fall back to its built-in templates — avoids
  // duplicating the 80-line prompt strings here. Override only when the project
  // has explicit per-prompt customization later.
  const directorInputs: Record<string, unknown> = {
    audio: ['1', 0],
    analysis_json: p.analysisJson,
    captioner_gguf: p.captionerGguf ?? DEFAULT_CAPTIONER_GGUF,
    captioner_mmproj: p.captionerMmproj ?? DEFAULT_CAPTIONER_MMPROJ,
    shot_seconds: p.shotSeconds ?? SCENES_DEFAULT_SHOT_SECONDS,
    style_hint: p.styleHint ?? '',
    prompt_treatment: p.promptTreatment ?? '',
    prompt_chunk_scenes: p.promptChunkScenes ?? '',
    identifier: p.identifier ?? '',
  };
  if (p.audioChunkSeconds !== undefined) directorInputs.audio_chunk_seconds = p.audioChunkSeconds;
  if (p.treatmentTemperature !== undefined) directorInputs.treatment_temperature = p.treatmentTemperature;
  if (p.scenesTemperature !== undefined) directorInputs.scenes_temperature = p.scenesTemperature;
  if (p.maxTokensTreatment !== undefined) directorInputs.max_tokens_treatment = p.maxTokensTreatment;
  if (p.maxTokensScenes !== undefined) directorInputs.max_tokens_scenes = p.maxTokensScenes;
  if (p.ctxSize !== undefined) directorInputs.ctx_size = p.ctxSize;

  return {
    '1': {
      class_type: 'OMNI_AUDIO_LoadAudioPath',
      inputs: { path: p.audioPath },
    },
    '2': {
      class_type: 'OMNI_AUDIO_VideoScenes',
      inputs: directorInputs,
    },
  };
}
