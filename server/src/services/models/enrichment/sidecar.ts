// Sidecar read/write helpers.
//
// Studio sidecar lives at `{model-dir}/{basename}.studio.metadata.json` —
// distinct from CLM's `{basename}.metadata.json` so neither tool overwrites
// the other. When Studio enriches a model for the first time and CLM has
// already written its sidecar, we read CLM's as a fallback baseline (see
// `readClmSidecar`) and inherit relevant fields without ever touching CLM's
// file.
//
// `safeResolve` is NOT applicable here: the model path comes from the DB's
// abs_path (already absolute and validated at scan time); we only need to
// derive the sibling sidecar path, which can never escape a directory that
// already holds a model file the user installed. Path-traversal is therefore
// not a concern for sidecar writes.

import fs from 'fs';
import path from 'path';
import type { BaseModelMeta } from './types.js';

/**
 * Derive Studio's sidecar path for a model file.
 * e.g. `/mnt/models/loras/foo.safetensors` → `.../foo.studio.metadata.json`
 */
export function sidecarPath(absModelPath: string): string {
  const dir = path.dirname(absModelPath);
  const base = path.basename(absModelPath, path.extname(absModelPath));
  return path.join(dir, `${base}.studio.metadata.json`);
}

/**
 * Derive CLM's sidecar path for a model file. Used only for reading — Studio
 * never writes to this path.
 * e.g. `/mnt/models/loras/foo.safetensors` → `.../foo.metadata.json`
 */
export function clmSidecarPath(absModelPath: string): string {
  const dir = path.dirname(absModelPath);
  const base = path.basename(absModelPath, path.extname(absModelPath));
  return path.join(dir, `${base}.metadata.json`);
}

/** Returns true if Studio's sidecar file exists for the given model path. */
export function sidecarExists(absModelPath: string): boolean {
  return fs.existsSync(sidecarPath(absModelPath));
}

/**
 * Read and parse Studio's sidecar. Returns `null` if the file doesn't exist
 * or fails to parse — callers treat `null` as "no Studio sidecar yet".
 */
export function readSidecar(absModelPath: string): BaseModelMeta | null {
  const sp = sidecarPath(absModelPath);
  try {
    if (!fs.existsSync(sp)) return null;
    const raw = fs.readFileSync(sp, 'utf8');
    return JSON.parse(raw) as BaseModelMeta;
  } catch {
    return null;
  }
}

/**
 * Read CLM's sidecar (if it exists) and map its shape onto BaseModelMeta.
 * Used as a fallback baseline on first Studio enrichment so we inherit CLM's
 * SHA256, downloaded preview path, tags, description, etc. without ever
 * writing back to CLM's file.
 */
export function readClmSidecar(absModelPath: string): BaseModelMeta | null {
  const sp = clmSidecarPath(absModelPath);
  try {
    if (!fs.existsSync(sp)) return null;
    const raw = JSON.parse(fs.readFileSync(sp, 'utf8')) as Record<string, unknown>;
    const civitai = (raw.civitai as Record<string, unknown> | undefined) ?? undefined;
    const modelBlock = civitai?.model as Record<string, unknown> | undefined;
    const previewUrlValue = typeof raw.preview_url === 'string' ? raw.preview_url : undefined;
    // CLM's preview_url is an absolute path on disk; we want the basename so
    // catalog overlay can serve it via /models/preview/{save_path}/{basename}.
    const localPreviewBasename = previewUrlValue
      ? path.basename(previewUrlValue)
      : undefined;
    const description = (modelBlock?.description as string | undefined)
      ?? (typeof raw.modelDescription === 'string' ? raw.modelDescription : undefined);
    const tags = (modelBlock?.tags as string[] | undefined)
      ?? (Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined);
    const trainedWords = (civitai?.trainedWords as string[] | undefined) ?? undefined;
    return {
      filename: typeof raw.file_name === 'string' ? raw.file_name : path.basename(absModelPath),
      save_path: '', // caller fills from input
      model_name: typeof raw.model_name === 'string' ? raw.model_name : undefined,
      base_model: typeof raw.base_model === 'string' ? raw.base_model : undefined,
      description,
      tags,
      trigger_words: trainedWords,
      sha256: typeof raw.sha256 === 'string' ? raw.sha256 : undefined,
      sha256_status: raw.hash_status === 'completed' ? 'done' : undefined,
      civitai_model_id: typeof civitai?.modelId === 'number' ? civitai.modelId : undefined,
      civitai_version_id: typeof civitai?.id === 'number' ? civitai.id : undefined,
      civitai_deleted: raw.civitai_deleted === true ? true : undefined,
      nsfw_level: typeof civitai?.nsfwLevel === 'number' ? civitai.nsfwLevel : undefined,
      preview_local_path: localPreviewBasename,
      metadata_source: raw.from_civitai === true ? 'civitai' : undefined,
      favorite: raw.favorite === true ? true : undefined,
      exclude: raw.exclude === true ? true : undefined,
      notes: typeof raw.notes === 'string' && raw.notes !== '' ? raw.notes : undefined,
      usage_tips: typeof raw.usage_tips === 'string' && raw.usage_tips !== '{}' ? raw.usage_tips : undefined,
      civitai_raw: civitai,
    };
  } catch {
    return null;
  }
}

/**
 * Look for an existing preview image file next to the model — checks the
 * common extensions CLM writes (jpeg/jpg/png/webp) as well as Studio's own
 * `.preview.jpg` convention. Returns the basename of the first match found,
 * or `null` if none.
 */
export function findExistingPreview(absModelPath: string): string | null {
  const dir = path.dirname(absModelPath);
  const base = path.basename(absModelPath, path.extname(absModelPath));
  // Order: Studio's convention first, then CLM's most common extensions.
  const candidates = [
    `${base}.preview.jpg`,
    `${base}.preview.jpeg`,
    `${base}.preview.png`,
    `${base}.preview.webp`,
    `${base}.jpeg`,
    `${base}.jpg`,
    `${base}.png`,
    `${base}.webp`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(dir, c))) return c;
  }
  return null;
}

/**
 * Write a sidecar atomically (tmp+rename). Creates the parent directory if
 * needed, same as `atomicWrite` in lib/fs.ts but without the 0o600 mode lock
 * — sidecar files live next to model files and should be world-readable so
 * CLM-compatible tools can consume them.
 */
export function writeSidecar(absModelPath: string, meta: BaseModelMeta): void {
  const sp = sidecarPath(absModelPath);
  const dir = path.dirname(sp);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${sp}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
  fs.renameSync(tmp, sp);
}
