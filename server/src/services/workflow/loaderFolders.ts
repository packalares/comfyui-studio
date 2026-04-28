// Static map from a loader node's class_type to the ComfyUI model folder
// it reads from. Used by the import-resolver path so a model file ends up
// in the right `models/<folder>/` directory regardless of the URL's
// path/filename (which the upstream `guessFolder` heuristic in
// resolveHuggingface.ts can only see).
//
// Why this exists:
//   - Filename-only heuristics confuse `LatentUpscaleModelLoader` files
//     with plain `UpscaleModelLoader` files because both contain "upscal".
//   - Filename-only heuristics confuse text-encoder weights with
//     checkpoints because the ext fallback is `checkpoints`.
//   - The workflow itself knows: each filename is referenced by exactly
//     one loader node whose class_type is unambiguous.
//
// Extend this map when a new loader class shows up in a workflow we
// import; the dep-extractor records the (filename → loader class) pairing,
// commit-time / resolve-time consumers look it up here.
//
// IMPORTANT: keep entries sorted alphabetically by class name. Folders
// must match the keys in COMFY_DIR_TO_HUB_SUBDIR (sharedModelHub.ts).

export const LOADER_CLASS_FOLDER: Readonly<Record<string, string>> = {
  CheckpointLoader: 'checkpoints',
  CheckpointLoaderSimple: 'checkpoints',
  CLIPLoader: 'clip',
  CLIPVisionLoader: 'clip_vision',
  ControlNetLoader: 'controlnet',
  DiffControlNetLoader: 'controlnet',
  DualCLIPLoader: 'clip',
  GLIGENLoader: 'gligen',
  HypernetworkLoader: 'hypernetworks',
  IPAdapterModelLoader: 'ipadapter',
  LatentUpscaleModelLoader: 'latent_upscale_models',
  LoraLoader: 'loras',
  LoraLoaderModelOnly: 'loras',
  LTXAVTextEncoderLoader: 'text_encoders',
  PhotoMakerLoader: 'photomaker',
  QuadrupleCLIPLoader: 'clip',
  StyleModelLoader: 'style_models',
  TripleCLIPLoader: 'clip',
  UnetLoaderGGUF: 'unet',
  UNETLoader: 'unet',
  UpscaleModelLoader: 'upscale_models',
  VAELoader: 'vae',
};

/**
 * Look up the ComfyUI model folder for a given loader node `class_type`.
 * Returns `undefined` for unknown loaders so callers can fall back to
 * the filename / URL heuristic without losing the existing behaviour.
 */
export function folderForLoaderClass(classType: string | undefined): string | undefined {
  if (!classType) return undefined;
  return LOADER_CLASS_FOLDER[classType];
}
