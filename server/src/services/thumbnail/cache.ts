// Cache layout for the unified thumbnail service.
//
// Bucketing: `<cacheRoot>/thumbs/<aa>/<md5>.webp` where `<aa>` is the first
// two hex chars of the md5. Spreading 256-wide keeps directory listings cheap
// even as the cache grows past O(10k) files — a flat dir becomes a slog on
// any filesystem once directory entries hit the low thousands.

import { createHash } from 'crypto';
import {
  existsSync, mkdirSync, renameSync, statSync, unlinkSync,
} from 'fs';
import path from 'path';
import { env } from '../../config/env.js';

const REMOTE_BUCKET_MS = 24 * 60 * 60 * 1000;

export function cacheRoot(): string {
  return path.join(env.COMFYUI_PATH || '/root/ComfyUI', '.cache', 'thumbs');
}

export function legacyFlatDir(): string {
  // Original `imgProxy.service` flat cache; the sweep keeps it tidy but
  // writes go to the bucketed tree.
  return cacheRoot();
}

export function legacyVideoDir(): string {
  return path.join(env.COMFYUI_PATH || '/root/ComfyUI', '.cache', 'video-thumbs');
}

export interface CachePath {
  filePath: string;
  tmpPath: string;
  bucketDir: string;
  key: string;
}

/**
 * Derive the on-disk webp path for a key. Side-effect: ensures the two-char
 * bucket dir exists so downstream writes don't need a second mkdir call.
 */
export function cachePathForKey(key: string): CachePath {
  const bucket = key.slice(0, 2);
  const bucketDir = path.join(cacheRoot(), bucket);
  if (!existsSync(bucketDir)) mkdirSync(bucketDir, { recursive: true });
  const filePath = path.join(bucketDir, `${key}.webp`);
  return { filePath, tmpPath: `${filePath}.tmp`, bucketDir, key };
}

/**
 * Local-file cache key: md5 of absolute path + width + mtimeMs. mtime is
 * included so replacing the source file at the same path invalidates the
 * cached thumbnail without needing a manual cache wipe. A missing source
 * falls through with mtime=0; downstream pipelines will then fail and the
 * route will 404.
 */
export function localFileKey(absPath: string, width: number): string {
  let mtime = 0;
  try { mtime = statSync(absPath).mtimeMs; } catch { /* missing */ }
  return createHash('md5').update(`${absPath}|${width}|${mtime}`).digest('hex');
}

/**
 * Remote-URL cache key: md5 of url + width + 24h-bucket. The rolling bucket
 * is a coarse TTL so CDNs that re-serve changed bytes at the same URL don't
 * pin a stale thumbnail forever — within a day we'll re-fetch at worst once.
 */
export function remoteUrlKey(url: string, width: number): string {
  const bucketKey = Math.floor(Date.now() / REMOTE_BUCKET_MS);
  return createHash('md5').update(`${url}|${width}|${bucketKey}`).digest('hex');
}

/**
 * Return a cached file path when the key is present AND the file has bytes.
 * Returns null on miss; callers then generate + write.
 */
export function peekCached(key: string): string | null {
  const { filePath } = cachePathForKey(key);
  if (!existsSync(filePath)) return null;
  try {
    if (statSync(filePath).size > 0) return filePath;
  } catch { /* fall through to miss */ }
  return null;
}

/**
 * Atomic publish: rename tmp -> final so partial writes are never served.
 * On failure, best-effort unlink the tmp so leaked tmps don't accumulate.
 */
export function publishTmp(tmpPath: string, finalPath: string): void {
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}
