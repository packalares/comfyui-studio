// Data tables for architecture detection. Kept separate from the detection
// logic so the vocabulary is easy to extend.
//
// A structural Rule matches a model by the SIGNATURE of its tensor keys.
// Tokens are matched by `KeyView.has` (see detect.ts): a plain token must be a
// top-level or level-2 key prefix; a `~`-prefixed token is a substring probe
// over the full key list (robust to wrapping like `model.diffusion_model.…`).
// Rules are evaluated in order, first match wins — put specific before generic.

export interface Rule {
  name: string;
  requires: string[]; // ALL must match
  forbids: string[]; // ANY match disqualifies
  family: string;
  role: string;
  confidence: number;
  /** Weak match — a later layer (metadata / shape probe) may override. */
  ambiguous: boolean;
}

export const RULES: Rule[] = [
  // ---- audio ----
  { name: 'acestep_ckpt', requires: ['~audio_vae', '~vocoder'], forbids: [], family: 'ACE-Step', role: 'checkpoint', confidence: 0.9, ambiguous: false },
  { name: 'acestep_dit', requires: ['~detokenizer', '~tokenizer', '~decoder', '~encoder'], forbids: ['~first_stage_model', '~double_blocks'], family: 'ACE-Step', role: 'diffusion_model', confidence: 0.75, ambiguous: true },
  { name: 'stable_audio', requires: ['~pretransform', '~conditioner.conditioners'], forbids: [], family: 'StableAudio', role: 'checkpoint', confidence: 0.8, ambiguous: false },

  // ---- DiT / MMDiT image + video (distinctive signatures) ----
  { name: 'sd3_mmdit', requires: ['~joint_blocks', '~x_embedder', '~context_embedder'], forbids: [], family: 'SD3', role: 'diffusion_model', confidence: 0.88, ambiguous: false },
  { name: 'flux_dit', requires: ['~double_blocks', '~single_blocks', '~img_in', '~txt_in'], forbids: ['~vector_in.individual', '~audio'], family: 'FLUX.1', role: 'diffusion_model', confidence: 0.75, ambiguous: true },
  { name: 'hunyuan_video', requires: ['~double_blocks', '~single_blocks', '~txt_in.individual_token_refiner'], forbids: [], family: 'HunyuanVideo', role: 'diffusion_model', confidence: 0.85, ambiguous: false },
  { name: 'wan_dit', requires: ['~patch_embedding', '~text_embedding', '~time_embedding'], forbids: ['~joint_blocks'], family: 'WAN', role: 'diffusion_model', confidence: 0.85, ambiguous: false },
  { name: 'ltx_video', requires: ['~transformer_blocks', '~patchify_proj'], forbids: [], family: 'LTX-Video', role: 'diffusion_model', confidence: 0.82, ambiguous: false },
  { name: 'qwen_image', requires: ['~transformer_blocks', '~img_in', '~txt_norm'], forbids: ['~double_blocks'], family: 'Qwen-Image', role: 'diffusion_model', confidence: 0.72, ambiguous: true },
  { name: 'pixart', requires: ['~blocks', '~x_embedder', '~t_embedder', '~y_embedder'], forbids: ['~joint_blocks'], family: 'PixArt', role: 'diffusion_model', confidence: 0.8, ambiguous: false },
  { name: 'auraflow', requires: ['~double_layers', '~single_layers', '~cond_seq_linear'], forbids: [], family: 'AuraFlow', role: 'diffusion_model', confidence: 0.82, ambiguous: false },
  { name: 'lumina', requires: ['~layers', '~cap_embedder', '~x_embedder', '~t_embedder'], forbids: ['~y_embedder'], family: 'Lumina', role: 'diffusion_model', confidence: 0.75, ambiguous: true },
  { name: 'cascade', requires: ['~clip_txt_pooled_mapper', '~down_blocks', '~up_blocks'], forbids: [], family: 'Cascade', role: 'diffusion_model', confidence: 0.8, ambiguous: false },
  { name: 'svd', requires: ['~time_stack', '~input_blocks', '~output_blocks'], forbids: [], family: 'SVD', role: 'diffusion_model', confidence: 0.8, ambiguous: false },
  { name: 'mochi', requires: ['~blocks', '~t_embedder', '~pos_frequencies'], forbids: [], family: 'Mochi', role: 'diffusion_model', confidence: 0.78, ambiguous: false },

  // ---- bundled full checkpoints (unet + vae + text encoder) ----
  { name: 'sd_bundled', requires: ['~model.diffusion_model', '~first_stage_model'], forbids: ['~audio_vae'], family: 'StableDiffusion', role: 'checkpoint', confidence: 0.7, ambiguous: true },

  // ---- classic UNet (SD1.x/2.x/SDXL) — variant refined by shape probe ----
  { name: 'sd_unet', requires: ['~input_blocks', '~middle_block', '~output_blocks', '~time_embed'], forbids: [], family: 'StableDiffusion', role: 'diffusion_model', confidence: 0.6, ambiguous: true },

  // ---- ControlNet ----
  { name: 'controlnet_hint', requires: ['~input_hint_block', '~zero_convs'], forbids: [], family: 'ControlNet', role: 'controlnet', confidence: 0.88, ambiguous: false },
  { name: 'controlnet_model', requires: ['~control_model'], forbids: [], family: 'ControlNet', role: 'controlnet', confidence: 0.7, ambiguous: true },

  // ---- VAE standalone (heavily negative-gated so a full checkpoint never falls here) ----
  { name: 'vae_standalone', requires: ['~encoder.down', '~decoder.up'], forbids: ['~model.diffusion_model', '~double_blocks', '~joint_blocks', '~transformer_blocks', '~input_blocks', '~conditioner', '~cond_stage_model'], family: 'VAE', role: 'vae', confidence: 0.78, ambiguous: false },

  // ---- text / vision encoders ----
  { name: 't5', requires: ['~encoder.block.0.layer', '~shared'], forbids: [], family: 'T5', role: 'text_encoder', confidence: 0.85, ambiguous: false },
  { name: 'clip_vision', requires: ['~vision_model.encoder.layers'], forbids: [], family: 'CLIP-Vision', role: 'clip_vision', confidence: 0.82, ambiguous: false },
  { name: 'clip', requires: ['~text_model.encoder.layers'], forbids: ['~vision_model'], family: 'CLIP', role: 'text_encoder', confidence: 0.8, ambiguous: false },

  // ---- upscalers ----
  { name: 'esrgan', requires: ['~RRDB_trunk', '~model.0.weight'], forbids: [], family: 'ESRGAN', role: 'upscaler', confidence: 0.72, ambiguous: true },
  { name: 'esrgan2', requires: ['~body.0.rdb1', '~conv_first'], forbids: [], family: 'ESRGAN', role: 'upscaler', confidence: 0.72, ambiguous: true },
];

// ---- metadata-declared architecture (authoritative when present) ----
// Probed in order; the FIRST metadata key that exists is used.
export const METADATA_KEYS = [
  'modelspec.architecture',
  'ss_base_model_version',
  'general.architecture',
  'architecture',
  'model_type',
  'modelspec.title',
  'general.name',
];

// Substring -> family. Ordered: the more specific token wins (flux-2 before flux).
export const METADATA_MAP: Array<[string, string]> = [
  ['flux-2', 'FLUX.2'], ['flux.2', 'FLUX.2'], ['flux2', 'FLUX.2'],
  ['flux', 'FLUX.1'],
  ['stable-diffusion-xl', 'SDXL'], ['sdxl', 'SDXL'], ['sd_xl', 'SDXL'],
  ['stable-diffusion-3', 'SD3'], ['sd3', 'SD3'], ['sd_3', 'SD3'],
  ['stable-diffusion-2', 'SD2.x'], ['sd2', 'SD2.x'],
  ['stable-diffusion-1', 'SD1.5'], ['sd1', 'SD1.5'], ['sd15', 'SD1.5'], ['v1-5', 'SD1.5'],
  ['pony', 'Pony'], ['illustrious', 'Illustrious'], ['noobai', 'NoobAI'],
  ['qwen', 'Qwen-Image'],
  ['hunyuanvideo', 'HunyuanVideo'], ['hunyuan_video', 'HunyuanVideo'],
  ['hunyuan3d', 'Hunyuan3D'], ['hunyuandit', 'HunyuanDiT'],
  ['wan', 'WAN'],
  ['ltx', 'LTX-Video'], ['ltxv', 'LTX-Video'],
  ['mochi', 'Mochi'], ['cogvideo', 'CogVideo'],
  ['acestep', 'ACE-Step'], ['ace-step', 'ACE-Step'], ['ace_step', 'ACE-Step'],
  ['stable_audio', 'StableAudio'], ['stableaudio', 'StableAudio'],
  ['lumina', 'Lumina'], ['hidream', 'HiDream'], ['auraflow', 'AuraFlow'],
  ['kolors', 'Kolors'], ['pixart', 'PixArt'], ['cascade', 'Cascade'],
  ['stable_cascade', 'Cascade'], ['cosmos', 'Cosmos'], ['t5', 'T5'], ['clip', 'CLIP'],
];

// ---- LoRA / adapter suffixes (name -> format), counted against total keys ----
export const ADAPTER_SUFFIXES: Array<[string, string]> = [
  ['.lora_down.weight', 'kohya'],
  ['.lora_up.weight', 'kohya'],
  ['.lora_A.weight', 'peft'],
  ['.lora_B.weight', 'peft'],
  ['.lora.down.weight', 'diffusers'],
  ['.lora.up.weight', 'diffusers'],
  ['.hada_w1_a', 'loha'],
  ['.lokr_w1', 'lokr'],
  ['.oft_blocks', 'oft'],
  ['.dora_scale', 'dora'],
];

// ---- dtype -> precision label + bit width ----
export const PRECISION_BY_DTYPE: Record<string, string> = {
  F64: 'fp64', F32: 'fp32', F16: 'fp16', BF16: 'bf16',
  F8_E4M3: 'fp8_e4m3', F8_E5M2: 'fp8_e5m2',
  I64: 'int64', I32: 'int32', I16: 'int16', I8: 'int8', U8: 'uint8',
  F4: 'fp4', NF4: 'nf4',
};

export const DTYPE_BITS: Record<string, number> = {
  F64: 64, F32: 32, F16: 16, BF16: 16, F8_E4M3: 8, F8_E5M2: 8,
  I64: 64, I32: 32, I16: 16, I8: 8, U8: 8, F4: 4, NF4: 4,
};

// The families we recognise (anything parsed but unmatched becomes "Other").
export const FAMILIES = new Set<string>([
  'SD1.5', 'SD2.x', 'SDXL', 'SD3', 'Pony', 'Illustrious', 'NoobAI',
  'FLUX.1', 'FLUX.2', 'StableDiffusion', 'Qwen-Image', 'PixArt', 'AuraFlow',
  'Lumina', 'HiDream', 'Kolors', 'Cascade', 'SVD', 'HunyuanDiT',
  'WAN', 'HunyuanVideo', 'LTX-Video', 'Mochi', 'CogVideo', 'Cosmos',
  'ACE-Step', 'StableAudio', 'Hunyuan3D',
  'VAE', 'T5', 'CLIP', 'CLIP-Vision', 'ControlNet', 'ESRGAN',
]);
