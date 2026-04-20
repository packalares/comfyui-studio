// Shared download orchestrator. Used by models + essentialModels services.
//
// Responsibilities:
// - Drive `lib/download.downloadFile` with the engine's `DownloadOptions`.
// - Maintain the per-task `DownloadProgress` record via `progressTracker`.
// - Record lifecycle transitions into `downloadHistory`.
// - Notify a broadcaster (wired by `services/downloads.ts`) on every update.
//
// This file stays thin: each concern lives in its own helper module.

import { randomUUID } from 'crypto';
import { logger } from '../../lib/logger.js';
import { downloadFile } from '../../lib/download/index.js';
import type { DownloadProgress } from '../../contracts/models.contract.js';
import * as tracker from './progressTracker.js';
import * as history from './downloadHistory.js';

export type ProgressListener = (taskId: string, progress: DownloadProgress) => void;

let broadcast: ProgressListener | null = null;

export function setProgressListener(fn: ProgressListener | null): void {
  broadcast = fn;
}

function emit(taskId: string): void {
  if (!broadcast) return;
  const p = tracker.getTask(taskId);
  if (p) broadcast(taskId, p);
}

/** Public: create a task and return its ID. */
export function createDownloadTask(): string {
  return tracker.createTask();
}

/** Public: is a task still tracked? */
export function hasTask(id: string): boolean {
  return tracker.hasTask(id);
}

export function getTaskProgress(id: string): DownloadProgress | undefined {
  return tracker.getTask(id);
}

/** Public: set shallow updates on a task and broadcast. */
export function updateTaskProgress(
  id: string,
  update: Partial<DownloadProgress>,
): void {
  tracker.updateTask(id, update);
  emit(id);
}

/** Public: abort the running task and mark it canceled in progress+history. */
export function cancelTask(id: string): boolean {
  if (!tracker.abortTask(id)) return false;
  const p = tracker.getTask(id);
  if (p) {
    const histItem = history.findHistoryByTaskId(id);
    if (histItem) {
      history.updateHistoryItem(histItem.id, {
        status: 'canceled',
        endTime: Date.now(),
        downloadedSize: p.downloadedBytes,
        fileSize: p.totalBytes,
        speed: p.speed,
      });
    }
  }
  emit(id);
  tracker.removeModelMappingByTaskId(id);
  logger.info('download canceled', { taskId: id });
  return true;
}

/**
 * Download a named model to `outputPath`. Mirrors launcher's
 * `downloadModelByName` 1:1. `authHeaders` is forwarded to the engine so
 * gated HF repos return 200.
 */
export async function downloadModelByName(
  modelName: string,
  downloadUrl: string,
  outputPath: string,
  taskId: string,
  opts: { source?: string; authHeaders?: Record<string, string> } = {},
): Promise<void> {
  const progress = tracker.getTask(taskId);
  if (!progress) {
    throw new Error(`Progress record missing for task ${taskId}`);
  }
  progress.status = 'downloading';
  progress.startTime = Date.now();
  progress.abortController = new AbortController();
  emit(taskId);

  const historyId = randomUUID();
  history.addHistoryItem({
    id: historyId,
    modelName,
    status: 'downloading',
    startTime: Date.now(),
    source: opts.source,
    savePath: outputPath,
    downloadUrl,
    taskId,
  });

  try {
    await runEngine(downloadUrl, outputPath, taskId, progress, opts.authHeaders);
    markCompleted(progress, taskId);
    history.updateHistoryItem(historyId, completedHistoryUpdates(progress));
    logger.info('download completed', { model: modelName });
  } catch (err) {
    handleDownloadError(err, progress, taskId, modelName, historyId);
    throw err;
  }
}

async function runEngine(
  url: string,
  outputPath: string,
  taskId: string,
  progress: DownloadProgress,
  authHeaders: Record<string, string> | undefined,
): Promise<void> {
  await downloadFile(
    url,
    outputPath,
    (percent, downloaded, total) => {
      progress.currentModelProgress = percent;
      progress.overallProgress = percent;
      progress.downloadedBytes = downloaded;
      progress.totalBytes = total;
      const now = Date.now();
      if (!progress.lastLogTime || now - progress.lastLogTime > 200) {
        emit(taskId);
        progress.lastLogTime = now;
      }
    },
    {
      abortController: progress.abortController || new AbortController(),
      onProgress: () => { /* engine calls the positional cb above */ },
      authHeaders,
    },
    progress,
  );
}

function markCompleted(progress: DownloadProgress, taskId: string): void {
  progress.status = 'completed';
  progress.completed = true;
  progress.overallProgress = 100;
  progress.currentModelProgress = 100;
  emit(taskId);
}

function completedHistoryUpdates(progress: DownloadProgress) {
  return {
    status: 'success' as const,
    endTime: Date.now(),
    fileSize: progress.totalBytes,
    downloadedSize: progress.downloadedBytes,
    speed: progress.speed,
  };
}

function handleDownloadError(
  err: unknown,
  progress: DownloadProgress,
  taskId: string,
  modelName: string,
  historyId: string,
): void {
  if (progress.canceled) {
    logger.info('download canceled mid-stream', { model: modelName });
    history.updateHistoryItem(historyId, {
      status: 'canceled',
      endTime: Date.now(),
      downloadedSize: progress.downloadedBytes,
      fileSize: progress.totalBytes,
      speed: progress.speed,
    });
    emit(taskId);
    return;
  }
  progress.status = 'error';
  progress.error = err instanceof Error ? err.message : String(err);
  emit(taskId);
  history.updateHistoryItem(historyId, {
    status: 'failed',
    endTime: Date.now(),
    error: progress.error,
    downloadedSize: progress.downloadedBytes,
    fileSize: progress.totalBytes,
    speed: progress.speed,
  });
  logger.error('download failed', { model: modelName, message: progress.error });
}
