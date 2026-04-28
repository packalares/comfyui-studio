// Business-logic facade for the `/api/models/*` endpoints.
//
// Route handlers in `routes/models.routes.ts` are a thin translation layer
// over this module; no HTTP types live here.

import { logger } from '../../lib/logger.js';
import { getHfAuthHeaders } from '../../lib/http.js';
import * as bus from '../../lib/events.js';
import {
  getModelList, getModelInfo, updateCache, convertEssentialModelsToEntries,
} from './info.service.js';
import {
  refreshInstalledStatus, scanInstalledModels, deleteModel,
  inferModelType, getModelSaveDir,
} from './install.service.js';
import {
  buildDownloadUrl, processHfEndpoint, resolveOutputPath,
} from './download.service.js';
import type { CatalogModelEntry } from './download.service.js';
import {
  createDownloadTask, downloadModelByName, getTaskProgress, cancelTask,
} from '../downloadController/downloadController.service.js';
import {
  setModelMapping, getModelTaskId, clearModelMapping,
} from '../downloadController/progressTracker.js';
import { essentialModels } from '../essentialModels/essentialModels.data.js';
import { downloadHfRepo as downloadHfRepoImpl } from './downloadHfRepo.js';
import {
  downloadCustom as downloadCustomImpl,
  type DownloadCustomTokens,
} from './downloadCustom.js';

export type { CatalogModelEntry };

/** Merged catalog + essential list, deduped by filename/name/save_path. */
export async function getAllModels(
  mode: 'cache' | 'local' | 'remote' = 'cache',
): Promise<CatalogModelEntry[]> {
  const regular = getModelList(mode);
  const essentials = convertEssentialModelsToEntries(essentialModels);
  const byKey = new Map<string, CatalogModelEntry>();
  for (const m of regular) {
    const key = m.filename || m.name || m.save_path;
    if (key) byKey.set(key, m);
  }
  for (const m of essentials) {
    const key = m.filename || m.name || m.save_path;
    if (key) byKey.set(key, m);
  }
  return Array.from(byKey.values());
}

export { toWireEntry, type LauncherCompatEntry } from './models.wire.js';

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

/** Result of an install kick-off. */
export interface StartInstallResult {
  taskId: string;
  fileName: string;
}

/**
 * Launch an install task from the catalog. Resolves the URL via the launcher's
 * source-priority order (hf -> mirror -> cdn) and passes HF auth when available.
 */
export async function installFromCatalog(
  modelName: string,
  source: string = 'hf',
  hfToken?: string,
): Promise<StartInstallResult> {
  if (!modelName) throw new Error('Model name cannot be empty');
  // Dedup via model mapping: if a download for this model is already active,
  // return its taskId instead of creating a new one. Preserves launcher
  // behaviour on repeated install calls.
  const existingTask = getModelTaskId(modelName);
  if (existingTask) return { taskId: existingTask, fileName: modelName };

  const info = getModelInfo(modelName);
  if (!info) throw new Error(`Model info not found for ${modelName}`);

  const taskId = createDownloadTask();
  setModelMapping(modelName, taskId);

  const modelType = inferModelType(modelName);
  const saveDir = getModelSaveDir(modelType);
  const outputPath = resolveOutputPath(saveDir, modelName);
  let url = buildDownloadUrl(info, source);
  url = processHfEndpoint(url);
  logger.info('install download starting', { url, path: outputPath });

  void downloadModelByName(modelName, url, outputPath, taskId, {
    source, authHeaders: getHfAuthHeaders(url, hfToken),
  }).then(() => {
    // Notify readiness subscribers that a new file landed on disk. Rescan
    // is best-effort; readiness hooks run their own scan.
    bus.emit('model:installed', { filename: modelName });
    scanAndRefresh().catch(() => { /* best effort */ });
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('install download failed', { modelName, message: msg });
    bus.emit('model:download-failed', { filename: modelName, error: msg });
  });
  return { taskId, fileName: modelName };
}

/**
 * Start a custom download. Thin wrapper around `downloadCustom.ts` that
 * threads `scanAndRefresh` so the worker rescans on completion without
 * importing this file (which would cycle).
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
 * Download an entire HuggingFace repo via `huggingface-cli download`. The
 * heavy implementation lives in `downloadHfRepo.ts`; this thin wrapper
 * threads `scanAndRefresh` so the worker can fire a rescan after success
 * without importing this file (which would cycle through models.service).
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

/** Fetch progress snapshot by taskId (or modelName). Returns null if unknown. */
export function getProgress(
  id: string,
): import('../../contracts/models.contract.js').DownloadProgress | null {
  const byName = getModelTaskId(id);
  const task = byName || id;
  const p = getTaskProgress(task);
  return p || null;
}

export { scanInstalledModels };
