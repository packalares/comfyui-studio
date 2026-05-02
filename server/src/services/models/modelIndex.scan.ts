// Walker logic for the SQLite-backed model index. Split out of
// `modelIndex.ts` so the public API stays under the 250-line cap.
//
// Reuses `scanDirectory` from `install.scan.ts` for the recursive walk +
// integrity probe, then translates the resulting Map<storePath, ScanInfo>
// into normalised rows the repo can upsert.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { scanDirectory, type ScanInfo } from './install.scan.js';
import { getSharedModelHubRoot } from './sharedModelHub.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import type { ModelFileRow, RootKind } from '../../lib/db/modelFiles.repo.js';

export interface ScanRoot {
  /** Absolute filesystem root that owns the immediate subdirs we walk. */
  root: string;
  kind: RootKind;
}

/**
 * Resolve the local + hub roots that should be walked. Local always points at
 * `<COMFYUI_PATH>/models`; hub is included only when `SHARED_MODEL_HUB_PATH`
 * is set and the directory exists on disk (the read-only mount may be absent
 * in dev).
 */
export function resolveScanRoots(): ScanRoot[] {
  const roots: ScanRoot[] = [];
  const localRoot = path.join(env.COMFYUI_PATH, 'models');
  roots.push({ root: localRoot, kind: 'local' });
  const hubRoot = getSharedModelHubRoot();
  if (hubRoot && fs.existsSync(hubRoot)) {
    roots.push({ root: hubRoot, kind: 'hub' });
  }
  return roots;
}

/** List immediate subdirectories of `root`. Returns [] on missing root. */
function listImmediateSubdirs(root: string): string[] {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Walk `subdir` of `root` and persist every model file as a row. */
async function indexSubdir(
  root: string,
  subdir: string,
  kind: RootKind,
  scannedAt: number,
): Promise<number> {
  const absSubdir = path.join(root, subdir);
  // `scanDirectory` keys by relative-to-root when `rootForRelative !== null`
  // and by absolute path when null. We always pass `root` so storePaths come
  // back as `<subdir>/...`, then derive abs_path by joining with `root`.
  const scanned = new Map<string, ScanInfo>();
  await scanDirectory(absSubdir, scanned, root);
  let count = 0;
  for (const [storePath, info] of scanned.entries()) {
    const absPath = path.join(root, storePath);
    const row: ModelFileRow = {
      abs_path: absPath,
      filename: info.filename,
      rel_path: storePath,
      root_kind: kind,
      top_dir: subdir,
      size: info.size,
      status: info.status,
      scanned_at: scannedAt,
    };
    modelFiles.upsert(row);
    count += 1;
  }
  return count;
}

export interface RebuildOutcome {
  added: number;
  removed: number;
  total: number;
}

/**
 * Walk every immediate subdir of every scan root, upsert every discovered
 * file, and drop any stale rows whose `scanned_at` is older than the start
 * timestamp of this rebuild. Returns counts so the route handler can echo a
 * useful summary.
 */
export async function rebuildAll(): Promise<RebuildOutcome> {
  const startedAt = Date.now();
  let added = 0;
  for (const { root, kind } of resolveScanRoots()) {
    const subdirs = listImmediateSubdirs(root);
    for (const sub of subdirs) {
      try {
        added += await indexSubdir(root, sub, kind, startedAt);
      } catch (err) {
        logger.error('model index subdir scan failed', {
          root, subdir: sub,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const removed = modelFiles.deleteScannedBefore(startedAt);
  const total = modelFiles.countAll();
  logger.info('model index rebuild complete', { added, removed, total });
  return { added, removed, total };
}

/**
 * Stat one file and upsert / remove its row. Used by the bus listener after a
 * download lands so the index reflects the new file without a full walk.
 */
export async function syncOneAbsPath(absPath: string): Promise<void> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(absPath);
  } catch {
    logger.info('model index sync: file missing, skipping', { absPath });
    return;
  }
  if (!st.isFile()) return;
  const placement = classifyAbsPath(absPath);
  if (!placement) {
    logger.warn('model index sync: path outside known roots', { absPath });
    return;
  }
  const filename = path.basename(absPath);
  modelFiles.upsert({
    abs_path: absPath,
    filename,
    rel_path: placement.relPath,
    root_kind: placement.kind,
    top_dir: placement.topDir,
    size: st.size,
    status: 'complete',
    scanned_at: Date.now(),
  });
}

interface Placement {
  kind: RootKind;
  /** First path segment under the owning root (e.g. `checkpoints`). */
  topDir: string;
  /** Path relative to the owning root. */
  relPath: string;
}

/** Locate which scan root (if any) contains `absPath` and derive its top_dir. */
function classifyAbsPath(absPath: string): Placement | null {
  for (const { root, kind } of resolveScanRoots()) {
    const rel = path.relative(root, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.length === 0) continue;
    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.length === 0) continue;
    return { kind, topDir: segments[0], relPath: rel };
  }
  return null;
}
