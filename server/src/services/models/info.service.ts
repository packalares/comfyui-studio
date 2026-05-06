// Catalog access (in-memory + on-disk JSON).
//
// Reads the user-config cache file at `~/.config/comfyui-studio/model-list.cache.json`.
// First-boot seeding from the bundled `server/data/model-list.json` is done by
// `ensureModelListCacheSeeded()` before any reader is called. Upstream refresh
// only happens via the explicit Rescan endpoint.

import fs from 'fs';
import path from 'path';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { resolveModelFilePath } from './sharedModelHub.js';
import type { CatalogModelEntry } from './download.service.js';
import type { EssentialModel } from '../../contracts/models.contract.js';

interface ModelListBody {
  models?: Array<Record<string, unknown>>;
}

// Read the user-config cache directly here (rather than importing
// `getCachedModelList`) to keep `modelListCache.ts -> info.service.ts ->
// modelListCache.ts` from forming a runtime cycle: `modelListCache.ts` calls
// `invalidateModelListMemo` from this file.
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
 * on-disk cache. Wired from `modelListCache.refreshModelListFromUpstream`
 * and `ensureModelListCacheSeeded` so the memo never serves a stale list
 * after a cache write.
 */
export function invalidateModelListMemo(): void {
  memCache = null;
}

/** Look up an entry by `name` (launcher contract). */
export function getModelInfo(modelName: string): CatalogModelEntry | undefined {
  return getModelList().find((m) => m.name === modelName);
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
  const savePath = `models/${model.dir}/${model.out}`;
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
