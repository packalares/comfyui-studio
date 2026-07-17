// Business-logic facade for the `/api/models/*` endpoints + launcher-wire shape.
// Route handlers in `routes/models.routes.ts` are a thin translation layer
// over this module; no HTTP types live here.

import path from 'path';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import { pairKey } from './identity.js';
// Read directly from the store layer to avoid a cycle:
// catalog/service.ts -> models/service.ts -> catalog/service.ts.
import { load as loadCatalogStore } from '../catalog/store.js';
import { urlSourceFor } from '../catalog/urlSources.js';
import * as settings from '../settings/index.js';
import { env } from '../../config/env.js';
import {
  getModelList, getModelInfo, updateCache, convertEssentialModelsToEntries,
} from './info.js';
import {
  refreshInstalledStatus, scanInstalledModels, deleteModel,
  inferModelType, getModelSaveDir,
} from './install.js';
import {
  buildDownloadUrl, processHfEndpoint, resolveOutputPath,
} from './downloadUrl.js';
import type { CatalogModelEntry } from './downloadUrl.js';
import {
  createDownloadTask, cancelTask,
} from '../downloads/controller.js';
import { walkAndDownload } from '../downloads/walker.js';
import type { UrlSource } from '../../contracts/catalog.contract.js';
import {
  setModelMapping, getModelTaskId, clearModelMapping,
} from '../downloads/controller.js';
import { essentialModels } from '../essentialModels/essentialModels.data.js';
import { downloadHfRepo as downloadHfRepoImpl } from './download.js';
import {
  downloadCustom as downloadCustomImpl,
  type DownloadCustomTokens,
} from './download.js';

export type { CatalogModelEntry };

// ── Wire shape ────────────────────────────────────────────────────────────────
//
// Studio's `catalog.getMergedModels` consumes this exact shape; must not
// drift without a matching update over there.

export interface LauncherCompatEntry {
  filename?: string;
  name?: string;
  save_path: string;
  type?: string;
  fileSize?: number;
  installed?: boolean;
  url?: string;
  base?: string;
  description?: string;
  reference?: string;
  fileStatus?: 'complete' | 'incomplete' | 'corrupted' | 'unknown';
  size?: string;
}

/** Strip the COMFYUI_PATH prefix from a catalog `save_path` so the wire never
 *  carries an absolute filesystem path. Older catalog imports occasionally
 *  stored an abs path here; everywhere else the value is already relative. */
function relativizeSavePath(savePath: string): string {
  if (!savePath || !path.isAbsolute(savePath)) return savePath;
  const root = env.COMFYUI_PATH;
  if (!root) return path.basename(savePath);
  const rel = path.relative(root, savePath);
  // `path.relative` yields '..' when savePath escapes root; in that case
  // surface only the basename so we don't emit a traversal segment either.
  return rel.startsWith('..') ? path.basename(savePath) : rel;
}

/** Flatten a catalog entry into the launcher-wire shape. */
export function toWireEntry(m: CatalogModelEntry): LauncherCompatEntry {
  const url = typeof m.url === 'string'
    ? m.url
    : m.url?.hf || m.url?.mirror || m.url?.cdn;
  return {
    filename: m.filename,
    name: m.name,
    save_path: relativizeSavePath(m.save_path),
    type: m.type,
    fileSize: m.fileSize,
    installed: m.installed,
    url,
    base: m.base,
    description: m.description,
    reference: m.reference,
    fileStatus: m.fileStatus,
    size: m.size,
  };
}

// ── Service functions ─────────────────────────────────────────────────────────

/** Merged catalog + essential list, deduped by (save_path, filename) pair key.
 *  Falls back to `name` as secondary key for entries that have no filename
 *  (audit A1: the old key of `filename || name || save_path` collapsed entries
 *  that shared a filename but lived in different save_paths). */
export async function getAllModels(
  mode: 'cache' | 'local' | 'remote' = 'cache',
): Promise<CatalogModelEntry[]> {
  const regular = getModelList(mode);
  const essentials = convertEssentialModelsToEntries(essentialModels);
  const byKey = new Map<string, CatalogModelEntry>();
  for (const m of regular) {
    const key = m.filename ? pairKey({ save_path: m.save_path, filename: m.filename, type: m.type }) : m.name;
    if (key) byKey.set(key, m);
  }
  for (const m of essentials) {
    const key = m.filename ? pairKey({ save_path: m.save_path, filename: m.filename, type: m.type }) : m.name;
    if (key) byKey.set(key, m);
  }
  return Array.from(byKey.values());
}

/** Refresh disk status + update cache. Returns the updated list. */
export async function scanAndRefresh(): Promise<CatalogModelEntry[]> {
  try {
    const models = await getAllModels();
    const updated = await refreshInstalledStatus(models);
    updateCache(updated);
    return updated;
  } catch (err) {
    logger.error('refresh status failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Same as scanAndRefresh, but also returns the installed count. */
export async function scan(): Promise<{ models: CatalogModelEntry[]; count: number }> {
  logger.info('model scan requested');
  const updated = await scanAndRefresh();
  return { models: updated, count: updated.filter((m) => m.installed).length };
}

/**
 * Start a custom download. Thin wrapper around `download.ts` that threads
 * `scanAndRefresh` so the worker rescans on completion without importing
 * this file (which would cycle).
 */
export async function downloadCustom(
  srcUrl: string,
  modelDir: string,
  tokens: DownloadCustomTokens,
  filenameOverride?: string,
): Promise<{ taskId: string; fileName: string; saveDir: string }> {
  return downloadCustomImpl(srcUrl, modelDir, tokens, scanAndRefresh, filenameOverride);
}

/**
 * Download an entire HuggingFace repo via `huggingface-cli download`. Thin
 * wrapper that threads `scanAndRefresh` so the worker can fire a rescan after
 * success without importing this file (cycle through models/service).
 */
export async function downloadHfRepo(
  hfRepo: string, directory: string, displayName: string,
  opts: { hfToken?: string } = {},
): Promise<{ taskId: string; modelName: string; saveDir: string }> {
  return downloadHfRepoImpl(hfRepo, directory, displayName, scanAndRefresh, opts);
}

/** Delete a model from disk; refreshes the install-state cache after. */
export async function deleteByName(
  modelName: string,
): Promise<{ success: boolean; message: string }> {
  const models = await getAllModels();
  const res = await deleteModel(modelName, models);
  if (res.success) await scanAndRefresh();
  return res;
}

/** Polymorphic delete — identifier is one of (abs_path | sha256 | pair | name).
 *  Resolves via `model_files` first (collision-free), falls back to catalog
 *  walk on `modelName` for legacy callers. */
export async function deleteByIdentityWrap(
  id: import('./install.js').DeleteIdentity,
): Promise<{ success: boolean; message: string }> {
  const { deleteByIdentity } = await import('./install.js');
  const models = await getAllModels();
  const res = await deleteByIdentity(id, models);
  if (res.success) await scanAndRefresh();
  return res;
}

/** Cancel a download by task or model name. */
export function cancelDownload(opts: { taskId?: string; modelName?: string }): {
  success: boolean; message: string;
} {
  if (opts.taskId) {
    const ok = cancelTask(opts.taskId);
    return ok
      ? { success: true, message: `Task ${opts.taskId} has been cancelled` }
      : { success: false, message: `Task not found: ${opts.taskId}` };
  }
  if (opts.modelName) {
    const taskId = getModelTaskId(opts.modelName);
    if (!taskId) return { success: false, message: `No active download for ${opts.modelName}` };
    const ok = cancelTask(taskId);
    clearModelMapping(opts.modelName);
    return ok
      ? { success: true, message: `Download of model ${opts.modelName} has been cancelled` }
      : { success: false, message: `Cancel failed for ${opts.modelName}` };
  }
  return { success: false, message: 'Missing model name or task ID' };
}

export { scanInstalledModels };
