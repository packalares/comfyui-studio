// Cache sweep: age-based purge + LRU trim to a byte cap.
//
// Runs async from the boot handler (30s post-start to avoid fighting cold-
// start) and on a 6h interval. Yields back to the event loop every ~1000
// file ops so large caches don't stall request handling.

import {
  existsSync, readdirSync, statSync, unlinkSync,
} from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { cacheRoot, legacyVideoDir } from './cache.js';

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
  setTimeout(() => { void runSweep(); }, 30_000);
  setInterval(() => { void runSweep(); }, 6 * 60 * 60 * 1000);
}
