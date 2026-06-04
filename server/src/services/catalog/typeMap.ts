// save_path → canonical `type` derivation.
//
// The `type` field is UI metadata — display badge, category filter. ComfyUI
// never reads it. Upstream catalogs (ComfyUI-Manager + template authors) drift
// through 67 distinct strings for what's really ~15 categories: `lora` /
// `loras` / `motion lora` all describe files that live in `loras/`.
//
// Source of truth for the type IS the save_path. Once a catalog row says
// `save_path: 'loras'`, the type is 'lora' regardless of what the upstream
// author wrote. This module maps the top-level save_path segment to a
// canonical type. Unknown save_paths fall through to 'other'.

import { canonicalFolderName } from './folderRegistry.js';

export type CanonicalType =
  | 'checkpoint'
  | 'diffusion_model'
  | 'lora'
  | 'vae'
  | 'text_encoder'
  | 'clip_vision'
  | 'controlnet'
  | 'embedding'
  | 'upscaler'
  | 'hypernetwork'
  | 'style_model'
  | 'gligen'
  | 'photomaker'
  | 'classifier'
  | 'audio_encoder'
  | 'face_model'
  | 'ip_adapter'
  | 'pulid'
  | 'face_restore'
  | 'face_detection'
  | 'detection'
  | 'llm'
  | 'llm_gguf'
  | 'tts'
  | 'animatediff'
  | 'configs'
  | 'depth'
  | 'colorization'
  | 'segmentation'
  | 'model_patch'
  | 'background_removal'
  | 'other';

// Mapping is keyed by top-level save_path segment AFTER alias resolution.
// Keys are written in lowercase; lookup lowercases the input so PascalCase
// folders (`AnimateDiff`, `LLM`, `TTS`, `SEEDVR2`) resolve correctly.
const SAVE_PATH_TO_TYPE: Record<string, CanonicalType> = {
  // ComfyUI core
  checkpoints: 'checkpoint',
  diffusion_models: 'diffusion_model',
  loras: 'lora',
  vae: 'vae',
  text_encoders: 'text_encoder',
  clip_vision: 'clip_vision',
  controlnet: 'controlnet',
  embeddings: 'embedding',
  upscale_models: 'upscaler',
  latent_upscale_models: 'upscaler',
  hypernetworks: 'hypernetwork',
  style_models: 'style_model',
  gligen: 'gligen',
  photomaker: 'photomaker',
  classifiers: 'classifier',
  model_patches: 'model_patch',
  audio_encoders: 'audio_encoder',
  frame_interpolation: 'other',
  configs: 'configs',
  diffusers: 'other',
  vae_approx: 'vae',

  // GGUF quantization variants (registered by ComfyUI-GGUF custom_node).
  unet_gguf: 'diffusion_model',
  clip_gguf: 'text_encoder',

  // Face-related (3 distinct ML tasks, kept separate).
  insightface: 'face_model',
  facerestore_models: 'face_restore',
  face_restore: 'face_restore',        // legacy name (pre-rename)
  facedetection: 'face_detection',
  facedetection_models: 'face_detection',

  // Detection / segmentation.
  detection: 'detection',
  ultralytics: 'detection',
  sams: 'segmentation',
  sam: 'segmentation',
  groundingdino: 'detection',
  yolo_world: 'detection',
  instance_models: 'detection',
  sdpose_ood: 'detection',

  // Depth + colorization + background removal.
  depthanything: 'depth',
  depth: 'depth',
  ddcolor: 'colorization',
  rmbg: 'background_removal',
  inspyrenet: 'background_removal',

  // Upscalers (custom-node-registered).
  rgt: 'upscaler',
  seedvr2: 'upscaler',
  rams: 'upscaler',
  invsr: 'upscaler',

  // IP-Adapter family.
  ipadapter: 'ip_adapter',
  'ipadapter-flux': 'ip_adapter',
  instantid: 'ip_adapter',
  xlabs: 'ip_adapter',

  // LLM-ish.
  pulid: 'pulid',
  llm: 'llm',
  llm_gguf: 'llm_gguf',
  prompt_generator: 'llm',
  'janus-pro': 'llm',
  'acestep-captioner': 'llm',
  'acestep-transcriber': 'llm',

  // Audio / animation.
  tts: 'tts',
  animatediff_models: 'animatediff',
  animatediff: 'animatediff',
  animatediff_motion_lora: 'lora',

  // Style / encoders.
  nsfw_detector: 'classifier',
  seecoders: 'other',
  blip: 'classifier',
  deepbump: 'other',
  moge: 'depth',
};

/** Look up the canonical type. Case-insensitive on the top-level segment so
 *  PascalCase folders match lowercase map keys. */
export function canonicalType(save_path: string | undefined): CanonicalType {
  if (!save_path) return 'other';
  const top = canonicalFolderName(save_path).split('/')[0].toLowerCase();
  return SAVE_PATH_TO_TYPE[top] ?? 'other';
}
