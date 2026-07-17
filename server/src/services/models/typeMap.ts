// Single source of truth for catalog-type -> ComfyUI models/<dir> mappings.
// Both the HTTP GET /models/type-map endpoint and the server-internal
// `getModelSaveDir` helper delegate here so the two never drift.
// Pure module — no I/O, no imports, safe to tree-shake.

/** Catalog `type` value -> ComfyUI `models/<subdir>` name. */
export const TYPE_TO_DIR: Readonly<Record<string, string>> = {
  upscale: 'upscale_models',
  upscaler: 'upscale_models',
  checkpoint: 'checkpoints',
  checkpoints: 'checkpoints',
  lora: 'loras',
  loras: 'loras',
  vae: 'vae',
  VAE: 'vae',
  TAESD: 'vae_approx',
  vae_approx: 'vae_approx',
  controlnet: 'controlnet',
  embedding: 'embeddings',
  embeddings: 'embeddings',
  'IP-Adapter': 'ipadapter',
  ipadapter: 'ipadapter',
  clip: 'clip',
  clip_vision: 'clip_vision',
  text_encoder: 'text_encoders',
  text_encoders: 'text_encoders',
  diffusion_model: 'diffusion_models',
  diffusion_models: 'diffusion_models',
  unet: 'unet',
  inpaint: 'inpaint',
  hypernetworks: 'hypernetworks',
};

/** CivitAI `type` label -> ComfyUI `models/<subdir>` name.
 *  Matches the vocabulary civitaiTypeToFolder() in resolvers.ts uses.
 *  Keys are canonical CivitAI type strings (mixed-case as returned by API). */
export const CIVITAI_TYPE_TO_DIR: Readonly<Record<string, string>> = {
  Checkpoint: 'checkpoints',
  LORA: 'loras',
  LoRA: 'loras',
  LoCon: 'loras',
  Lycoris: 'loras',
  TextualInversion: 'embeddings',
  'Textual Inversion': 'embeddings',
  Embedding: 'embeddings',
  VAE: 'vae',
  Controlnet: 'controlnet',
  ControlNet: 'controlnet',
  Upscaler: 'upscale_models',
  Hypernetwork: 'hypernetworks',
  MotionModule: 'animatediff_models',
  AestheticGradient: 'embeddings',
};

/** Look up the `models/<subdir>` path for a catalog type.
 *  Falls back to `models/checkpoints` for unknown types (same behaviour as
 *  the switch-statement `getModelSaveDir` it replaces). */
export function modelSaveDir(modelType: string): string {
  const dir = TYPE_TO_DIR[modelType];
  return dir ? `models/${dir}` : 'models/checkpoints';
}

/** Look up the subdir (without the `models/` prefix) for a CivitAI type.
 *  Returns undefined when the type is not in the known vocabulary. */
export function civitaiTypeToDir(civitaiType: string | undefined): string | undefined {
  if (!civitaiType) return undefined;
  // Exact match first, then case-insensitive fallback.
  const exact = CIVITAI_TYPE_TO_DIR[civitaiType];
  if (exact !== undefined) return exact;
  const lower = civitaiType.toLowerCase();
  for (const [k, v] of Object.entries(CIVITAI_TYPE_TO_DIR)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
