// Canonical list of ComfyUI model subdirectories.
//
// Imported by:
//   - services/models/install.service.ts — disk-scan walker
//   - services/templates/readiness.ts   — per-file "is it installed?" probe
//
// Previously both files kept their own literal copy. Adding a new subdir
// (the ComfyUI 0.3.51+ cohort: `latent_upscale_models`, `audio_encoders`,
// `vae_approx`, `photomaker`, `gligen`, `mmaudio`) required touching both,
// and either one drifting silently produced "template ready on one page,
// dep check says missing on another" inconsistencies.
//
// `LOADER_TYPES` in `services/workflow/constants.ts` is a different concept
// (node class names, not filesystem paths) so is intentionally NOT DRY'd
// with this list.
export const MODEL_SUBDIRS: readonly string[] = [
  // Classic set, unchanged since launcher parity.
  'checkpoints', 'loras', 'vae', 'controlnet', 'upscale_models', 'embeddings',
  'inpaint', 'diffusion_models', 'clip', 'clip_vision', 'hypernetworks',
  'ipadapter', 'unet', 'style_models', 'facerestore_models', 'text_encoders',
  // ComfyUI 0.3.51+ template cohort (LTX-2.3 / SD3.5-era). Missing these
  // made the catalog mark files as `installed: false` even when on disk.
  'latent_upscale_models', 'audio_encoders', 'vae_approx', 'photomaker',
  'gligen', 'mmaudio',
];
