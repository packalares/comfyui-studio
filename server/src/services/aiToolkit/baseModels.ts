// Base-model discovery + resolution for the Train LoRA page.
//
// Two sources a user can train against:
//   1. A local checkpoint already installed under ComfyUI's `checkpoints/` or
//      `diffusion_models/` folders (Flux is commonly distributed as a
//      diffusion_models-only unet, SDXL/SD-family as a full checkpoint).
//   2. A bare HuggingFace repo id (`org/name`) — ai-toolkit resolves + caches
//      that itself via `name_or_path` at train time, same as ComfyUI's own
//      "download on first use" model fields. Presets are offered for the
//      common archs; a user can also type any other repo id.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { ValidationError } from '../../lib/errors.js';
import { getPathsForFolder } from '../catalog/folderRegistry.js';
import type { AiToolkitArch } from './config.js';

const MODEL_EXTS = new Set(['.safetensors', '.ckpt']);
const LOCAL_FOLDERS = ['checkpoints', 'diffusion_models'] as const;

export interface LocalBaseModel {
  source: 'local';
  /** Filename only — the value the client sends back in `baseModel`. Never
   *  the absolute host path (kept server-side only). */
  id: string;
  folder: string;
  sizeBytes: number;
}

export interface HuggingFaceBaseModelPreset {
  source: 'huggingface';
  id: string;
  label: string;
  arch: AiToolkitArch;
  note?: string;
}

export const HF_BASE_MODEL_PRESETS: HuggingFaceBaseModelPreset[] = [
  { source: 'huggingface', id: 'black-forest-labs/FLUX.1-dev', label: 'FLUX.1-dev', arch: 'flux', note: 'Gated — needs an accepted-license HF token' },
  { source: 'huggingface', id: 'black-forest-labs/FLUX.1-schnell', label: 'FLUX.1-schnell', arch: 'flux' },
  { source: 'huggingface', id: 'stabilityai/stable-diffusion-xl-base-1.0', label: 'SDXL base 1.0', arch: 'sdxl' },
  { source: 'huggingface', id: 'stabilityai/stable-diffusion-3.5-medium', label: 'Stable Diffusion 3.5 Medium', arch: 'sd35', note: 'Gated — needs an accepted-license HF token' },
];

/** Every folder root ComfyUI knows about for `checkpoints`/`diffusion_models`,
 *  falling back to the plain `${COMFYUI_PATH}/models/<folder>` default when
 *  the live folder registry hasn't loaded (e.g. ComfyUI isn't running). */
function localRootsFor(folder: typeof LOCAL_FOLDERS[number]): string[] {
  const registered = getPathsForFolder(folder);
  if (registered.length > 0) return registered;
  return env.COMFYUI_PATH ? [path.join(env.COMFYUI_PATH, 'models', folder)] : [];
}

/** Non-recursive top-level scan — matches how the training UI expects a flat
 *  dropdown, and keeps this fast even on a large model hub mount. */
export function listLocalBaseModels(): LocalBaseModel[] {
  const out: LocalBaseModel[] = [];
  const seen = new Set<string>();
  for (const folder of LOCAL_FOLDERS) {
    for (const root of localRootsFor(folder)) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!MODEL_EXTS.has(ext)) continue;
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(path.join(root, entry.name)).size; } catch { /* ignore */ }
        out.push({ source: 'local', id: entry.name, folder, sizeBytes });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const HF_REPO_ID_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Resolve a client-supplied `baseModel` string to what `model.name_or_path`
 * in the ai-toolkit config should contain: an absolute local path (found by
 * exact filename match under `checkpoints`/`diffusion_models`) or a bare HF
 * repo id passed straight through. Throws `ValidationError` for anything
 * else — this is the traversal guard: a filename that isn't an exact match
 * against a known model root, and doesn't look like `org/repo`, is rejected
 * rather than silently passed through as a path.
 */
export function resolveBaseModelPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ValidationError('baseModel is required');

  // A bare filename (no path separators) is looked up by exact match against
  // known model roots — `path.basename` is belt-and-braces so this can never
  // resolve outside those roots even if a caller smuggled a separator in.
  const isBareFilename = trimmed === path.basename(trimmed) && !trimmed.includes('\\');
  if (isBareFilename) {
    for (const folder of LOCAL_FOLDERS) {
      for (const root of localRootsFor(folder)) {
        const candidate = path.join(root, trimmed);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      }
    }
  }

  if (HF_REPO_ID_RE.test(trimmed)) return trimmed;

  throw new ValidationError(
    `baseModel "${trimmed}" is not an installed checkpoint filename and does not look like a HuggingFace repo id (org/name)`,
  );
}
