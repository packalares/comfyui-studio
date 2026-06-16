// Catalog access: in-memory memo + on-disk JSON cache + first-boot seeding.
//
// Single source of truth: `~/.config/comfyui-studio/model-list.cache.json`.
// On first boot the file is seeded from the bundled `server/data/model-list.json`.
// On subsequent boots the file is read as-is — no network fetch, no staleness
// check. The user-triggered Rescan endpoint is the only path that re-fetches
// upstream.
//
// Upstream `size` strings are unreliable (e.g. Lightning LoRAs declared 19.6GB
// when actual is 810MB) and trigger false-positive size-mismatch warnings,
// so the field is stripped from every entry on both seed and rescan writes.

import fs from 'fs';
import path from 'path';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { resolveModelFilePath } from './install.js';
import type { CatalogModelEntry } from './downloadUrl.js';
import type { EssentialModel } from '../../contracts/models.contract.js';

// ── On-disk cache helpers ─────────────────────────────────────────────────────

export interface ModelListBody {
  models?: Array<Record<string, unknown>>;
}

/** Upstream canonical model-list. Same URL the prior seed code used. */
const MODEL_LIST_URL =
  'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json';

function bundledListPath(): string {
  return path.join(paths.dataDir, 'model-list.json');
}

function readJsonFile(file: string): ModelListBody | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as ModelListBody;
  } catch (err) {
    logger.warn('modelListCache read failed', {
      file, message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Strip upstream-declared `size` so downstream consumers never see it. The
// upstream values are frequently wrong; relying on them produced false
// positive size-mismatch warnings that flagged correctly-downloaded files
// as `incomplete`.
function stripSize(entry: Record<string, unknown>): Record<string, unknown> {
  const { size: _omit, ...rest } = entry;
  return rest;
}

function stripSizesFromBody(body: ModelListBody): ModelListBody {
  if (!body || !Array.isArray(body.models)) return { models: [] };
  return { ...body, models: body.models.map(stripSize) };
}

/** Read the on-disk cache file. Returns `{ models: [] }` when absent. */
export function getCachedModelList(): ModelListBody {
  const cached = readJsonFile(paths.modelListCachePath);
  if (cached && Array.isArray(cached.models)) return cached;
  return { models: [] };
}

/**
 * First-boot seed: if the cache file does not yet exist, copy the bundled
 * list (size fields stripped) to the user config dir. No-op when the cache
 * already exists. Never overwrites an existing user file.
 */
export async function ensureModelListCacheSeeded(): Promise<void> {
  if (fs.existsSync(paths.modelListCachePath)) return;
  const bundled = readJsonFile(bundledListPath());
  if (!bundled || !Array.isArray(bundled.models)) {
    logger.warn('modelListCache: bundled seed missing', { file: bundledListPath() });
    return;
  }
  const stripped = stripSizesFromBody(bundled);
  atomicWrite(paths.modelListCachePath, JSON.stringify(stripped, null, 2));
  invalidateModelListMemo();
  logger.info('modelListCache: seeded from bundled', {
    count: stripped.models?.length ?? 0,
  });
}

/**
 * User-triggered upstream refresh. On success: parse, strip `size`, atomically
 * overwrite the cache, invalidate the memo, return `{ ok: true }`. On any
 * failure (network, non-2xx, parse): leave the existing cache intact and
 * return `{ ok: false, reason }`.
 */
export async function refreshModelListFromUpstream(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(MODEL_LIST_URL);
    if (!res.ok) {
      const reason = `upstream ${res.status}`;
      logger.warn('modelListCache refresh non-2xx', { status: res.status });
      return { ok: false, reason };
    }
    const body = await res.json() as ModelListBody;
    if (!body || !Array.isArray(body.models)) {
      return { ok: false, reason: 'upstream body shape invalid' };
    }
    const stripped = stripSizesFromBody(body);
    atomicWrite(paths.modelListCachePath, JSON.stringify(stripped, null, 2));
    invalidateModelListMemo();
    logger.info('modelListCache refreshed', { count: stripped.models?.length ?? 0 });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('modelListCache refresh failed', { message: reason });
    return { ok: false, reason };
  }
}

// ── In-memory memo ────────────────────────────────────────────────────────────

// Read the on-disk cache directly here (rather than calling getCachedModelList)
// to keep the cross-file call path simple: modelListCache.refreshModelListFromUpstream
// calls invalidateModelListMemo from this section — importing getCachedModelList
// from above is fine since everything is in the same module now.
function readCachedModelList(): ModelListBody {
  try {
    if (!fs.existsSync(paths.modelListCachePath)) return { models: [] };
    const raw = fs.readFileSync(paths.modelListCachePath, 'utf8');
    const parsed = JSON.parse(raw) as ModelListBody;
    if (parsed && Array.isArray(parsed.models)) return parsed;
    return { models: [] };
  } catch (err) {
    logger.warn('model list cache read failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { models: [] };
  }
}

const CACHE_DURATION = 24 * 60 * 60 * 1000;

interface CachedCatalog {
  models: CatalogModelEntry[];
  ts: number;
}

let memCache: CachedCatalog | null = null;

/** Load from the on-disk cache; re-read at most once per CACHE_DURATION. */
export function getModelList(mode: 'cache' | 'local' | 'remote' = 'cache'): CatalogModelEntry[] {
  if (mode === 'cache' && memCache && Date.now() - memCache.ts < CACHE_DURATION) {
    return memCache.models;
  }
  try {
    const body = readCachedModelList();
    const models = (body.models as CatalogModelEntry[] | undefined) || [];
    memCache = { models, ts: Date.now() };
    return models;
  } catch (err) {
    logger.error('model list load failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Drop the in-memory memo so the next `getModelList` call re-reads the
 * on-disk cache. Wired from `refreshModelListFromUpstream` and
 * `ensureModelListCacheSeeded` so the memo never serves a stale list
 * after a cache write.
 */
export function invalidateModelListMemo(): void {
  memCache = null;
}

/** Look up an entry by `name` or `filename` (launcher contract).
 *  Most upstream entries have a descriptive `name` ≠ `filename`, so callers
 *  passing a filename (e.g. dep check) miss without the filename fallback. */
export function getModelInfo(modelName: string): CatalogModelEntry | undefined {
  return getModelList().find((m) => m.name === modelName || m.filename === modelName);
}

/** Replace the in-memory cache (used after a disk-status refresh). */
export function updateCache(models: CatalogModelEntry[]): void {
  memCache = { models, ts: Date.now() };
}

export function getCacheTimestamp(): number {
  return memCache?.ts ?? 0;
}

/**
 * Convert the ported-in essential-models list into the launcher's ModelInfo
 * wire shape so downstream consumers (scan response, catalog merge) see a
 * uniform schema.
 */
export function convertEssentialModelsToEntries(
  essentialModels: EssentialModel[],
): CatalogModelEntry[] {
  try {
    return essentialModels.map((m) => essentialToEntry(m));
  } catch (err) {
    logger.error('convert essential models failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function essentialToEntry(model: EssentialModel): CatalogModelEntry {
  // save_path is a DIRECTORY relative to ComfyUI's models/ tree — never a
  // path that includes the filename, and never carrying the literal `models/`
  // prefix. The old form `models/${dir}/${out}` produced a string ending in
  // the filename, which made the merge key in getMergedModels diverge from
  // the catalog row (whose save_path is just `dir`), rendered as a phantom
  // duplicate, and then forced matchInstalled to fail because the would-be
  // disk key landed under `models/<dir>/<filename>/<filename>`.
  const savePath = model.dir;
  const modelsRoot = path.join(env.COMFYUI_PATH, 'models');
  const resolved = resolveModelFilePath(modelsRoot, model.dir, model.out);
  let fileSize = 0;
  let fileStatus: 'complete' | 'incomplete' | 'corrupted' | 'unknown' = 'unknown';
  if (resolved) {
    try {
      fileSize = fs.statSync(resolved).size;
      fileStatus = fileSize > 0 ? 'complete' : 'incomplete';
    } catch (err) {
      logger.error('essential file stat failed', {
        path: resolved,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    name: model.name,
    type: model.type,
    base_url: '',
    save_path: savePath,
    description: model.description,
    filename: model.out,
    installed: !!resolved && fileSize > 0,
    fileStatus,
    fileSize,
    url: model.url.mirror || model.url.hf,
  };
}

/** For tests. */
export function __resetForTests(): void {
  memCache = null;
}
