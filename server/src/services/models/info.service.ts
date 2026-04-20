// Catalog access (in-memory + bundled JSON).
//
// We intentionally skip remote fetch of `model-list.json`; we rely on the
// bundled `server/data/model-list.json` that Agent F copied in.

import fs from 'fs';
import path from 'path';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { resolveModelFilePath } from './sharedModelHub.js';
import type { CatalogModelEntry } from './download.service.js';
import type { EssentialModel } from '../../contracts/models.contract.js';

const CACHE_DURATION = 24 * 60 * 60 * 1000;

interface CachedCatalog {
  models: CatalogModelEntry[];
  ts: number;
}

let memCache: CachedCatalog | null = null;

/** Path to the bundled model-list.json. */
function bundledListPath(): string {
  return path.join(paths.dataDir, 'model-list.json');
}

/** Load from bundled JSON; re-read at most once per CACHE_DURATION. */
export function getModelList(mode: 'cache' | 'local' | 'remote' = 'cache'): CatalogModelEntry[] {
  if (mode === 'cache' && memCache && Date.now() - memCache.ts < CACHE_DURATION) {
    return memCache.models;
  }
  try {
    const file = bundledListPath();
    if (!fs.existsSync(file)) {
      logger.warn('model-list.json missing', { file });
      return [];
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { models?: CatalogModelEntry[] };
    const models = parsed.models || [];
    memCache = { models, ts: Date.now() };
    return models;
  } catch (err) {
    logger.error('model list load failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
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
