// Shared model hub resolver.
//
// Maps ComfyUI's `models/<subdir>` layout onto the shared hub folder names
// used by ComfyUI's `extra_model_paths.yaml`. Call `resolveModelFilePath` to
// locate a file either under the local models tree or under the hub mount.
//
// Environment:
// - `env.MODELS_DIR` is the authoritative local root (see `config/paths.ts`).
// - `env.SHARED_MODEL_HUB_PATH` points at the mount (e.g. a shared volume).
import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';

/** ComfyUI `models/<topDir>` to hub `<subdir>` mapping. */
export const COMFY_DIR_TO_HUB_SUBDIR: Readonly<Record<string, string>> = {
  checkpoints: 'main',
  loras: 'lora',
  vae: 'vae',
  embeddings: 'embeddings',
  hypernetworks: 'hypernetworks',
  clip: 'clip',
  clip_vision: 'clip_vision',
  controlnet: 'controlnet',
  inpaint: 'inpaint',
  upscale_models: 'upscale_models',
  ipadapter: 'ipadapter',
  unet: 'unet',
  style_models: 'style_models',
  facerestore_models: 'facerestore_models',
  diffusion_models: 'diffusion_models',
  text_encoders: 'text_encoders',
};

/** Mount point for the shared model tree, or empty string when unset. */
export function getSharedModelHubRoot(): string {
  return (env.SHARED_MODEL_HUB_PATH || '').trim();
}

/** Hub subdirectory for a given ComfyUI top-level dir (falls back to identity). */
export function hubSubdirForComfyTopDir(topDir: string): string {
  return COMFY_DIR_TO_HUB_SUBDIR[topDir] || topDir;
}

/**
 * Resolve a model file: try local ComfyUI models tree first, then shared hub.
 * Returns the absolute path of the first match or `null` if nothing exists.
 *
 * `dirRelative` is the ComfyUI-native sub-path (e.g. `"checkpoints/flux"`)
 * and `outFile` is the filename.
 */
export function resolveModelFilePath(
  modelsRoot: string,
  dirRelative: string,
  outFile: string,
): string | null {
  const local = path.join(modelsRoot, dirRelative, outFile);
  if (fs.existsSync(local)) return local;

  const hubRoot = getSharedModelHubRoot();
  if (!hubRoot || !fs.existsSync(hubRoot)) return null;

  const segments = dirRelative.split(/[/\\]/).filter(Boolean);
  if (segments.length === 0) return null;
  const top = segments[0];
  const rest = segments.slice(1);
  const hubTop = hubSubdirForComfyTopDir(top);
  const hubPath = path.join(hubRoot, hubTop, ...rest, outFile);
  if (fs.existsSync(hubPath)) return hubPath;
  return null;
}

function uniqueHubSubdirs(): string[] {
  return [...new Set(Object.values(COMFY_DIR_TO_HUB_SUBDIR))];
}

/** Existing hub subdirectories to deep-scan for installed models. */
export function getExistingHubScanDirs(): string[] {
  const hubRoot = getSharedModelHubRoot();
  if (!hubRoot || !fs.existsSync(hubRoot)) return [];
  return uniqueHubSubdirs()
    .map((s) => path.join(hubRoot, s))
    .filter((p) => fs.existsSync(p));
}
