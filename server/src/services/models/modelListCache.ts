// Local cache of ltdrdata/ComfyUI-Manager's model-list.json.
//
// Cascade read order, used by both catalog seeding and `getModelList()`:
//   1. `~/.config/comfyui-studio/model-list.cache.json` (refreshed on boot).
//   2. Bundled `server/data/model-list.json` (read-only seed shipped in image).
//   3. Empty list.
//
// The cache survives upstream outages: a refresh failure leaves the prior
// cache file intact so seeding still works offline. Refresh staleness is
// bounded so a long-running pod periodically picks up new entries.

import fs from 'fs';
import path from 'path';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

/** Upstream canonical model-list. Same URL the prior seed code used. */
const MODEL_LIST_URL =
  'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json';

/** Re-fetch upstream after this age. 24 h is a friendly cadence. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ModelListBody {
  models?: Array<Record<string, unknown>>;
}

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

/**
 * Cache → bundled → empty cascade. Cheap synchronous read; safe to call from
 * boot paths or hot loops. Never throws.
 */
export function cascadeRead(): ModelListBody {
  const cached = readJsonFile(paths.modelListCachePath);
  if (cached && Array.isArray(cached.models)) return cached;
  const bundled = readJsonFile(bundledListPath());
  if (bundled && Array.isArray(bundled.models)) return bundled;
  return { models: [] };
}

function cacheIsFresh(): boolean {
  try {
    const st = fs.statSync(paths.modelListCachePath);
    if (!st.isFile()) return false;
    return Date.now() - st.mtimeMs < CACHE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Fetch upstream and write the local cache. No-op if the cache is fresh.
 * Network failures are swallowed (logged at warn) so seeding stays robust.
 */
export async function refreshModelListCache(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && cacheIsFresh()) return;
  try {
    const res = await fetch(MODEL_LIST_URL);
    if (!res.ok) {
      logger.warn('modelListCache refresh non-2xx', { status: res.status });
      return;
    }
    const body = await res.json() as ModelListBody;
    if (!body || !Array.isArray(body.models)) return;
    atomicWrite(paths.modelListCachePath, JSON.stringify(body, null, 2));
  } catch (err) {
    logger.warn('modelListCache refresh failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Sync cached list (for tests / diagnostics). Cascade-aware. */
export function getCachedModelList(): ModelListBody {
  return cascadeRead();
}
