// Local copy of ltdrdata/ComfyUI-Manager's model-list.json.
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
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import { invalidateModelListMemo } from './info.service.js';

/** Upstream canonical model-list. Same URL the prior seed code used. */
const MODEL_LIST_URL =
  'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json';

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
