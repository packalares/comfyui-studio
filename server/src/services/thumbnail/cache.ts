// Thumbnail cache: on-disk layout + age/LRU sweep.
// Layout: `<cacheRoot>/thumbs/<aa>/<md5>.webp` — 256 buckets keep directory
// listings cheap past O(10k) files.
// Sweep: runs 30s after boot and every 6h; yields every ~1000 file ops to
// avoid stalling request handling on large caches.

import { createHash } from 'crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const REMOTE_BUCKET_MS = 24 * 60 * 60 * 1000;

// ── Cache layout ─────────────────────────────────────────────────────────────

export function cacheRoot(): string {
  return path.join(env.COMFYUI_PATH, '.cache', 'thumbs');
}

export function legacyFlatDir(): string {
  // Original flat cache from the legacy image-proxy service; sweep keeps it
  // tidy but writes go to the bucketed tree.
  return cacheRoot();
}

export function legacyVideoDir(): string {
  return path.join(env.COMFYUI_PATH, '.cache', 'video-thumbs');
}

export interface CachePath {
  filePath: string;
  tmpPath: string;
  bucketDir: string;
  key: string;
}

/**
 * Derive the on-disk webp path for a key. Side-effect: ensures the bucket
 * dir exists so downstream writes don't need a second mkdir call.
 */
export function cachePathForKey(key: string): CachePath {
  const bucket = key.slice(0, 2);
  const bucketDir = path.join(cacheRoot(), bucket);
  if (!existsSync(bucketDir)) mkdirSync(bucketDir, { recursive: true });
  const filePath = path.join(bucketDir, `${key}.webp`);
  return { filePath, tmpPath: `${filePath}.tmp`, bucketDir, key };
}

/**
 * Local-file cache key: md5 of absolute path + width + mtimeMs. mtime
 * inclusion means replacing the source file invalidates the cached thumbnail
 * without a manual cache wipe.
 */
export function localFileKey(absPath: string, width: number): string {
  let mtime = 0;
  try { mtime = statSync(absPath).mtimeMs; } catch { /* missing */ }
  return createHash('md5').update(`${absPath}|${width}|${mtime}`).digest('hex');
}

/**
 * Remote-URL cache key: md5 of url + width + 24h-bucket. The rolling bucket
 * is a coarse TTL so CDNs that re-serve changed bytes at the same URL don't
 * pin a stale thumbnail forever.
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

// ── Pexels persist cache (lives under cacheRoot) ─────────────────────────────

const PEXELS_CACHE_FILE = '.pexels-cache.json';

export interface PexelsEntry {
  imageUrl: string;
  fetchedAt: number;
}

export function pexelsCacheFilePath(): string {
  return path.join(cacheRoot(), PEXELS_CACHE_FILE);
}

export function loadPexelsCache(ttlMs: number): Map<string, PexelsEntry> {
  const map = new Map<string, PexelsEntry>();
  const file = pexelsCacheFilePath();
  if (!existsSync(file)) return map;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, PexelsEntry>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.imageUrl === 'string' && typeof v.fetchedAt === 'number') {
        if (Date.now() - v.fetchedAt < ttlMs) map.set(k, v);
      }
    }
  } catch { /* corrupt cache — start fresh */ }
  return map;
}

export function persistPexelsCache(map: Map<string, PexelsEntry>): void {
  const dir = cacheRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const obj: Record<string, PexelsEntry> = {};
  for (const [k, v] of map) obj[k] = v;
  try { writeFileSync(pexelsCacheFilePath(), JSON.stringify(obj)); }
  catch { /* best-effort; memory cache remains intact */ }
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

const YIELD_EVERY = 1000;

interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

async function walkYielding(root: string, out: FileEntry[]): Promise<void> {
  if (!existsSync(root)) return;
  const stack: string[] = [root];
  let ops = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); }
    catch { continue; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try { st = statSync(full); }
      catch { continue; }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      }
      if (++ops >= YIELD_EVERY) {
        ops = 0;
        await new Promise<void>((r) => setImmediate(r));
      }
    }
  }
}

export interface SweepResult {
  deleted: number;
  kept: number;
  totalBytes: number;
  oldestDate: string | null;
  durationMs: number;
}

export async function runSweep(): Promise<SweepResult> {
  const started = Date.now();
  const all: FileEntry[] = [];
  await walkYielding(cacheRoot(), all);
  await walkYielding(legacyVideoDir(), all);

  const maxAgeMs = env.THUMB_CACHE_MAX_AGE_DAYS * 86_400_000;
  const ageCutoff = Date.now() - maxAgeMs;
  const kept: FileEntry[] = [];
  let deleted = 0;

  for (const entry of all) {
    if (entry.mtimeMs < ageCutoff) {
      try { unlinkSync(entry.path); deleted++; }
      catch { kept.push(entry); }
    } else {
      kept.push(entry);
    }
  }

  let totalBytes = kept.reduce((acc, e) => acc + e.size, 0);
  if (totalBytes > env.THUMB_CACHE_MAX_BYTES) {
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (kept.length > 0 && totalBytes > env.THUMB_CACHE_MAX_BYTES) {
      const oldest = kept.shift();
      if (!oldest) break;
      try {
        unlinkSync(oldest.path);
        totalBytes -= oldest.size;
        deleted++;
      } catch { /* keep and try next */ }
    }
  }

  const oldestEntry = kept.length > 0
    ? kept.reduce((m, e) => (e.mtimeMs < m.mtimeMs ? e : m), kept[0])
    : null;
  const result: SweepResult = {
    deleted,
    kept: kept.length,
    totalBytes,
    oldestDate: oldestEntry ? new Date(oldestEntry.mtimeMs).toISOString() : null,
    durationMs: Date.now() - started,
  };
  logger.info('thumbnail cache sweep', result);
  return result;
}

export interface ThumbnailStats {
  count: number;
  totalBytes: number;
  oldestMtimeMs: number | null;
  bucketCount: number;
}

export async function collectStats(): Promise<ThumbnailStats> {
  const all: FileEntry[] = [];
  await walkYielding(cacheRoot(), all);
  const buckets = new Set<string>();
  let totalBytes = 0;
  let oldest: number | null = null;
  for (const entry of all) {
    totalBytes += entry.size;
    if (oldest === null || entry.mtimeMs < oldest) oldest = entry.mtimeMs;
    const parent = path.basename(path.dirname(entry.path));
    if (parent.length === 2) buckets.add(parent);
  }
  return {
    count: all.length,
    totalBytes,
    oldestMtimeMs: oldest,
    bucketCount: buckets.size,
  };
}

export async function clearCache(): Promise<{ deleted: number }> {
  const all: FileEntry[] = [];
  await walkYielding(cacheRoot(), all);
  let deleted = 0;
  for (const entry of all) {
    try { unlinkSync(entry.path); deleted++; }
    catch { /* ignore */ }
  }
  return { deleted };
}

let scheduled = false;

/** Boot hook: schedule the 30s-delayed first sweep + 6h interval. Idempotent. */
export function scheduleSweeps(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { void runSweep(); }, 30_000).unref();
  setInterval(() => { void runSweep(); }, 6 * 60 * 60 * 1000).unref();
}
