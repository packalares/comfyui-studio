// Batch-download orchestration for the essential-models list.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getHfAuthHeaders } from '../../lib/http.js';
import { resolveModelFilePath } from '../models/sharedModelHub.js';
import {
  createDownloadTask,
  downloadModelByName,
  getTaskProgress,
  updateTaskProgress,
  cancelTask,
} from '../downloadController/downloadController.service.js';
import { essentialModels } from './essentialModels.data.js';
import type { EssentialModel } from '../../contracts/models.contract.js';

function comfyModelsPath(): string {
  return path.join(env.COMFYUI_PATH, 'models');
}

/** Public: read-only list. Used by GET /essential. */
export function listEssentialModels(): EssentialModel[] {
  return essentialModels;
}

/** Public: kick off a batch download; returns the task id immediately. */
export function startBatchDownload(
  source: string = 'hf',
  hfToken?: string,
): string {
  const taskId = createDownloadTask();
  logger.info('essential batch started', { taskId, source });
  void runBatch(taskId, source, hfToken).catch((err) => {
    logger.error('essential batch failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    updateTaskProgress(taskId, {
      error: err instanceof Error ? err.message : String(err),
      status: 'error',
      completed: true,
    });
  });
  return taskId;
}

async function runBatch(taskId: string, source: string, hfToken?: string): Promise<void> {
  const progress = getTaskProgress(taskId);
  if (!progress) throw new Error(`Progress record missing for task ${taskId}`);
  progress.status = 'downloading';
  progress.startTime = Date.now();
  progress.lastUpdateTime = Date.now();

  const root = comfyModelsPath();
  for (let i = 0; i < essentialModels.length; i++) {
    const cur = getTaskProgress(taskId);
    if (!cur || cur.canceled || (cur.status as string) === 'canceled') {
      logger.info('essential batch canceled', { taskId });
      return;
    }
    const model = essentialModels[i];
    if (!model?.dir || !model?.out) continue;
    await downloadOne(taskId, root, model, i, source, hfToken);
  }

  updateTaskProgress(taskId, {
    overallProgress: 100,
    currentModelProgress: 100,
    completed: true,
    status: 'completed',
  });
  logger.info('essential batch completed', { taskId });
}

async function downloadOne(
  taskId: string,
  root: string,
  model: EssentialModel,
  index: number,
  source: string,
  hfToken: string | undefined,
): Promise<void> {
  const progress = getTaskProgress(taskId);
  if (!progress) return;
  progress.currentModelIndex = index;
  progress.currentModel = model;
  progress.currentModelProgress = 0;
  progress.overallProgress = Math.floor((index / essentialModels.length) * 100);
  updateTaskProgress(taskId, progress);

  const modelDir = path.join(root, model.dir);
  if (!fs.existsSync(modelDir)) {
    logger.info('essential create dir', { dir: modelDir });
    fs.mkdirSync(modelDir, { recursive: true });
  }
  if (skipIfAlreadyInstalled(root, model, progress)) return;

  const url = source === 'hf' ? model.url.hf : model.url.mirror;
  if (!url) {
    logger.warn('essential no source', { model: model.name, source });
    return;
  }
  progress.abortController = new AbortController();
  try {
    await downloadModelByName(
      model.name, url, path.join(modelDir, model.out), taskId,
      { source, authHeaders: getHfAuthHeaders(url, hfToken) },
    );
    progress.currentModelProgress = 100;
    progress.overallProgress = Math.floor(((index + 1) / essentialModels.length) * 100);
    updateTaskProgress(taskId, progress);
  } catch (err) {
    if (progress.canceled) return;
    logger.error('essential download failed', {
      model: model.name,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function skipIfAlreadyInstalled(
  root: string,
  model: EssentialModel,
  progress: import('../../contracts/models.contract.js').DownloadProgress,
): boolean {
  const filePath = path.join(root, model.dir, model.out);
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 0) {
      logger.info('essential model exists, skipping', { model: model.name });
      progress.currentModelProgress = 100;
      return true;
    }
  } catch { /* treat as not present */ }
  return false;
}

/** Status lookup used by GET /essential-status. */
export function getInstallStatus(): {
  installed: boolean;
  total: number;
  installedCount: number;
  models: Array<{ id: string; name: string; installed: boolean; fileSize: number }>;
} {
  const root = comfyModelsPath();
  const list = essentialModels;
  const models = list.map((m) => statOne(root, m));
  const installedCount = models.filter((m) => m.installed).length;
  return {
    installed: installedCount === list.length,
    total: list.length,
    installedCount,
    models,
  };
}

function statOne(
  root: string,
  model: EssentialModel,
): { id: string; name: string; installed: boolean; fileSize: number } {
  if (!model.dir || !model.out) {
    return { id: model.id, name: model.name, installed: false, fileSize: 0 };
  }
  const resolved = resolveModelFilePath(root, model.dir, model.out);
  let fileSize = 0;
  if (resolved) {
    try { fileSize = fs.statSync(resolved).size; } catch { /* ignore */ }
  }
  return {
    id: model.id,
    name: model.name,
    installed: !!resolved && fileSize > 0,
    fileSize,
  };
}

/** Cancel a batch download. Matches launcher semantics (abort + mark canceled). */
export function cancelBatch(taskId: string): boolean {
  logger.info('essential batch cancel requested', { taskId });
  const p = getTaskProgress(taskId);
  if (!p) return false;
  p.canceled = true;
  const ok = cancelTask(taskId);
  return ok;
}
