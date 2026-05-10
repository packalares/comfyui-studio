// SQLite-backed model index: public API, mutex, freshness gate, bus subscriptions,
// and the walker that rebuilds it.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import type { ModelFileRow, RootKind } from '../../lib/db/modelFiles.repo.js';
import { scanDirectory, type ScanInfo, getSharedModelHubRoot } from './installScan.js';

// ── Walker ────────────────────────────────────────────────────────────────────

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

// ── Public API ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let inFlight: Promise<RebuildOutcome> | null = null;
let wired = false;

export async function rebuildFullIndex(): Promise<RebuildOutcome> {
  if (inFlight) return inFlight;
  inFlight = rebuildAll().finally(() => { inFlight = null; });
  return inFlight;
}

export async function syncOne(absPath: string): Promise<void> {
  await syncOneAbsPath(absPath);
}

export function removeOne(absPath: string): void {
  modelFiles.removeByAbsPath(absPath);
}

/**
 * Trigger a rebuild only when the index is empty or the oldest stamp is
 * older than `maxAgeMs`. Boot wiring calls this so the very first readiness
 * recompute sees a populated table without paying the walk on every restart.
 */
export async function ensureFresh(
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<void> {
  const total = modelFiles.countAll();
  if (total === 0) {
    await rebuildFullIndex();
    return;
  }
  const oldest = modelFiles.oldestScannedAt();
  if (oldest != null && oldest < Date.now() - maxAgeMs) {
    await rebuildFullIndex();
  }
}

export function getKnownTopDirs(): Set<string> {
  return modelFiles.listKnownTopDirs();
}

/**
 * Subscribe to the model lifecycle bus once. The install path emits
 * `model:installed` with the absolute on-disk path; we sync that single row
 * instead of a full walk. Removal events drop every row whose filename
 * matches (a single filename can live in multiple roots/dirs).
 */
export function wireModelIndexEventHandlers(): void {
  if (wired) return;
  wired = true;
  subscribe();
}

/** Test-only: re-subscribe after `bus.resetForTests()`. */
export function rewireForTests(): void {
  wired = true;
  subscribe();
}

function subscribe(): void {
  bus.on('model:installed', (payload) => {
    void (async () => {
      const absPath = (payload as { absPath?: string }).absPath;
      if (typeof absPath !== 'string' || absPath.length === 0) return;
      try {
        await syncOneAbsPath(absPath);
      } catch (err) {
        logger.warn('modelIndex model:installed sync failed', {
          absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  });

  bus.on('model:removed', ({ filename }) => {
    try {
      const rows = modelFiles.listByFilename(filename);
      for (const row of rows) modelFiles.removeByAbsPath(row.abs_path);
    } catch (err) {
      logger.warn('modelIndex model:removed sync failed', {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
