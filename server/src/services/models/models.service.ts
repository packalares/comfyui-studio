// Business-logic facade for the `/api/models/*` endpoints.
//
// Route handlers in `routes/models.routes.ts` are a thin translation layer
// over this module; no HTTP types live here.

import path from 'path';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { getHfAuthHeaders } from '../../lib/http.js';
import {
  getModelList, getModelInfo, updateCache, convertEssentialModelsToEntries,
} from './info.service.js';
import {
  refreshInstalledStatus, scanInstalledModels, deleteModel,
  inferModelType, getModelSaveDir,
} from './install.service.js';
import {
  buildDownloadUrl, processHfEndpoint, validateHfUrl, buildResolveUrl,
  ensureSaveDirectory, resolveOutputPath,
} from './download.service.js';
import type { CatalogModelEntry } from './download.service.js';
import {
  createDownloadTask, downloadModelByName, getTaskProgress, cancelTask,
} from '../downloadController/downloadController.service.js';
import {
  setModelMapping, getModelTaskId, clearModelMapping,
} from '../downloadController/progressTracker.js';
import { addHistoryItem } from '../downloadController/downloadHistory.js';
import { essentialModels } from '../essentialModels/essentialModels.data.js';
import { randomUUID } from 'crypto';

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
  }).catch((err) => {
    logger.error('install download failed', {
      modelName,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return { taskId, fileName: modelName };
}

/** Start a custom download (by HF URL). */
export async function downloadCustom(
  hfUrl: string,
  modelDir: string,
  hfToken?: string,
): Promise<{ taskId: string; fileName: string; saveDir: string }> {
  if (!hfUrl) throw new Error('Hugging Face URL cannot be empty');
  if (!modelDir) throw new Error('Model directory cannot be empty');
  const v = validateHfUrl(hfUrl);
  if (!v.isValid) throw new Error(v.error || 'Invalid URL');
  const fileName = v.fileName;

  // Dedup against the model-name index: launcher's download-custom also
  // registers under the filename, and studio's outer layer expects that.
  const existing = getModelTaskId(fileName);
  if (existing) return { taskId: existing, fileName, saveDir: modelDir };

  let url = buildResolveUrl(hfUrl);
  url = processHfEndpoint(url);

  const taskId = createDownloadTask();
  setModelMapping(fileName, taskId);
  const saveDir = `models/${modelDir}`;
  ensureSaveDirectory(saveDir);
  const outputPath = path.join(env.COMFYUI_PATH, saveDir, fileName);
  logger.info('custom download starting', { url, path: outputPath });

  addHistoryItem({
    id: randomUUID(),
    modelName: fileName,
    status: 'downloading',
    startTime: Date.now(),
    source: 'custom',
    savePath: outputPath,
    downloadUrl: url,
    taskId,
  });
  const progress = getTaskProgress(taskId);
  if (progress) progress.abortController = new AbortController();

  void downloadModelByName(fileName, url, outputPath, taskId, {
    source: 'custom', authHeaders: getHfAuthHeaders(url, hfToken),
  }).then(() => {
    // Rescan so the installed flag flips immediately after completion.
    scanAndRefresh().catch(() => { /* best effort */ });
  }).catch((err) => {
    logger.error('custom download failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return { taskId, fileName, saveDir };
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
