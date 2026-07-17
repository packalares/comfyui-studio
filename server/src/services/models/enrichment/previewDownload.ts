// Local preview image download + caching for model sidecars.
//
// WHY: CivitAI/HF preview thumbnails are remote URLs that break or load
// slowly. We download once, convert to WebP via sharp, and store the result
// next to the model file as `{basename}.preview.webp`.

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { env } from '../../../config/env.js';
import { safeResolve } from '../../../lib/fs.js';
import { validateAllowedUrl } from '../downloadUrl.js';
import { logger } from '../../../lib/logger.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const FETCH_TIMEOUT_MS = 30_000;

export type PreviewDownloadResult =
  | { ok: true; localPath: string; bytes: number }
  | { ok: false; error: string };

/** Where the local preview WOULD live for a given model path. Pure / no IO. */
export function previewPathFor(absModelPath: string): string {
  const dir = path.dirname(absModelPath);
  const base = path.basename(absModelPath, path.extname(absModelPath));
  return path.join(dir, `${base}.preview.webp`);
}

/** Does a local preview already exist? */
export async function hasLocalPreview(absModelPath: string): Promise<boolean> {
  return fs.existsSync(previewPathFor(absModelPath));
}

/**
 * Download a preview image from any URL and save as
 * `{model-dir}/{basename}.preview.webp` next to the model file.
 */
export async function downloadPreviewFor(
  absModelPath: string,
  previewUrl: string,
  opts?: { maxBytes?: number; nsfwThreshold?: number },
): Promise<PreviewDownloadResult> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  // URL safety check.
  const urlCheck = validateAllowedUrl(previewUrl);
  if (!urlCheck.ok) {
    return { ok: false, error: `URL rejected: ${urlCheck.error}` };
  }

  // Derive and verify the local path stays inside COMFYUI_PATH.
  let localPath: string;
  try {
    localPath = previewPathFor(absModelPath);
    safeResolve(env.COMFYUI_PATH, path.relative(env.COMFYUI_PATH, localPath));
  } catch (err) {
    return {
      ok: false,
      error: `Path escapes root: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Fetch with timeout + byte cap.
  let buffer: Buffer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(previewUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} fetching preview` };
    }

    // Stream with byte cap.
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: 'Response body missing' };

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => { /* ignore */ });
        return { ok: false, error: `Preview exceeds maxBytes (${maxBytes})` };
      }
      chunks.push(value);
    }
    buffer = Buffer.concat(chunks);
  } catch (err) {
    return {
      ok: false,
      error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Convert to WebP via sharp and write atomically. The tmp file MUST live in
  // the same directory as the target so `renameSync` stays within one
  // filesystem — `/tmp` is a separate volume from the models dir on most
  // container/k8s deployments, which makes cross-fs rename fail with EXDEV.
  const tmp = path.join(
    path.dirname(localPath),
    `.studio-preview-tmp-${process.pid}-${Date.now()}.webp`,
  );
  try {
    const webp = await sharp(buffer)
      .resize({ width: 1024, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(tmp, webp);
    fs.renameSync(tmp, localPath);

    return { ok: true, localPath, bytes: webp.byteLength };
  } catch (err) {
    // Clean up any partial tmp file.
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    logger.warn('previewDownload: sharp conversion failed', {
      absModelPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      error: `Conversion failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
