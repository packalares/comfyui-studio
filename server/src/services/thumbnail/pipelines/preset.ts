// Preset-asset pipeline: load a local preview image saved by the import
// hook into `<userTemplatesDir>/<parent>/<filename>`, resize through sharp,
// cache on disk. Same shape as `template.ts` minus the HTTP fetch — the
// source is always a local file because previews are downloaded + persisted
// at import time so subsequent loads are offline-clean.
//
// Trust model: assetPath is `<parent>/<filename>` and comes from the
// `template_presets` DB column (server-controlled). We still `safeResolve`
// under userTemplatesDir as defence in depth — same rule the rest of the
// userTemplates services apply.

import { createHash } from 'crypto';
import { createWriteStream, existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import sharp from 'sharp';
import { paths } from '../../../config/paths.js';
import { safeResolve } from '../../../lib/fs.js';
import { cachePathForKey, peekCached, publishTmp } from '../cache.js';
import { thumbnailPlaceholder } from './static.js';
import type { ThumbError, ThumbResult } from '../types.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Reject path segments that could escape the per-parent folder. The
 *  `safeResolve` below catches `..` traversal, but we also reject leading
 *  `/` and NUL early so the error is cleaner. */
function isSafePresetAssetPath(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('/')) return false;
  return true;
}

/** Cache key namespaced to the preset pipeline so a future asset re-using
 *  the same path with a new format doesn't collide with a prior cache. */
function presetAssetKey(assetPath: string, width: number): string {
  return createHash('md5').update(`preset|${assetPath}|${width}|webp`).digest('hex');
}

async function pipeBufferToWebp(
  bytes: Buffer, width: number, tmpPath: string, finalPath: string,
): Promise<void> {
  const pipeline = sharp(bytes).resize({ width, withoutEnlargement: true }).webp({ quality: 82 });
  const out = createWriteStream(tmpPath);
  try {
    await new Promise<void>((resolve, reject) => {
      pipeline.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      pipeline.pipe(out);
    });
    publishTmp(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export interface PresetAssetArgs {
  /** Relative path under `userTemplatesDir`, shape `<parent>/<filename>`. */
  assetPath: string;
  width: number;
}

export async function thumbnailForPresetAsset(
  args: PresetAssetArgs,
): Promise<ThumbResult> {
  if (!isSafePresetAssetPath(args.assetPath)) {
    throw { code: 'INVALID_PATH' } satisfies ThumbError;
  }

  let resolved: string;
  try {
    resolved = safeResolve(paths.userTemplatesDir, args.assetPath);
  } catch {
    throw { code: 'INVALID_PATH' } satisfies ThumbError;
  }

  const key = presetAssetKey(args.assetPath, args.width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };

  // Missing source file → transient placeholder so the grid renders. Once
  // the import hook lands the file the next load will pick it up; the
  // placeholder's `transient` flag keeps the browser from caching it.
  if (!existsSync(resolved)) return thumbnailPlaceholder();

  const stat = statSync(resolved);
  if (stat.size > MAX_FILE_BYTES) {
    throw { code: 'UPSTREAM_FAILED' } satisfies ThumbError;
  }
  const bytes = readFileSync(resolved);

  const { tmpPath, filePath } = cachePathForKey(key);
  try {
    await pipeBufferToWebp(bytes, args.width, tmpPath, filePath);
  } catch (err) {
    throw {
      code: 'UPSTREAM_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ThumbError;
  }
  return { kind: 'file', filePath, contentType: 'image/webp', cached: false };
}
