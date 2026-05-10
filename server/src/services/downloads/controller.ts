// Download orchestrator: drives lib/download with retry + cancel.
// Per-task progress state and history persistence are managed inline.

import { randomUUID } from 'crypto';
import { logger } from '../../lib/logger.js';
import { downloadFile, createDownloadProgress } from '../../lib/download/index.js';
import type { DownloadProgress } from '../../contracts/models.contract.js';
import * as history from './history.js';

// --- Per-task progress state ---

export type TaskId = string;

const tasks = new Map<TaskId, DownloadProgress>();
// Secondary index: modelName -> taskId (dedup for named downloads).
const byModel = new Map<string, TaskId>();

/** Allocate a new task and its initial progress record. */
export function createTask(): TaskId {
  const id = randomUUID();
  tasks.set(id, createDownloadProgress());
  return id;
}

export function getTask(id: TaskId): DownloadProgress | undefined {
  return tasks.get(id);
}

export function hasTask(id: TaskId): boolean {
  return tasks.has(id);
}

/** Shallow-merge `update` into an existing task. No-op if unknown id. */
export function updateTask(id: TaskId, update: Partial<DownloadProgress>): void {
  const cur = tasks.get(id);
  if (!cur) return;
  Object.assign(cur, update);
}

export function deleteTask(id: TaskId): void {
  tasks.delete(id);
  for (const [model, taskId] of byModel.entries()) {
    if (taskId === id) byModel.delete(model);
  }
}

export function setModelMapping(modelName: string, id: TaskId): void {
  byModel.set(modelName, id);
}

export function getModelTaskId(modelName: string): TaskId | undefined {
  return byModel.get(modelName);
}

export function clearModelMapping(modelName: string): void {
  byModel.delete(modelName);
}

export function removeModelMappingByTaskId(id: TaskId): string | undefined {
  for (const [model, taskId] of byModel.entries()) {
    if (taskId === id) { byModel.delete(model); return model; }
  }
  return undefined;
}

/** Abort the task's in-flight request, mark it canceled, return true if found. */
export function abortTask(id: TaskId): boolean {
  const p = tasks.get(id);
  if (!p) return false;
  p.status = 'error';
  p.error = 'Download canceled';
  p.canceled = true;
  if (p.abortController) {
    try { p.abortController.abort(); } catch { /* ignore */ }
  }
  return true;
}

/** Immutable snapshot safe to ship over the wire. */
export function snapshot(id: TaskId): DownloadProgress | null {
  const p = tasks.get(id);
  if (!p) return null;
  return {
    currentModel: p.currentModel ? { ...p.currentModel } : null,
    currentModelIndex: p.currentModelIndex || 0,
    overallProgress: p.overallProgress || 0,
    currentModelProgress: p.currentModelProgress || 0,
    completed: !!p.completed,
    error: p.error || null,
    downloadedBytes: p.downloadedBytes || 0,
    totalBytes: p.totalBytes || 0,
    speed: p.speed || 0,
    status: p.status || 'downloading',
  };
}

/** For tests only: drop every task so isolation is clean. */
export function __resetForTests(): void {
  tasks.clear();
  byModel.clear();
}

// --- Orchestrator ---

export type ProgressListener = (taskId: string, progress: DownloadProgress) => void;

let broadcast: ProgressListener | null = null;

export function setProgressListener(fn: ProgressListener | null): void {
  broadcast = fn;
}

function emit(taskId: string): void {
  if (!broadcast) return;
  const p = tasks.get(taskId);
  if (p) broadcast(taskId, p);
}

// Grace window keeps the final state readable via /progress briefly after
// completion; `unref` prevents the timer from blocking process exit.
const EVICTION_GRACE_MS = 30_000;
function scheduleEvict(taskId: string): void {
  setTimeout(() => deleteTask(taskId), EVICTION_GRACE_MS).unref();
}

export function createDownloadTask(): string {
  return createTask();
}

export function getTaskProgress(id: string): DownloadProgress | undefined {
  return getTask(id);
}

export function updateTaskProgress(
  id: string,
  update: Partial<DownloadProgress>,
): void {
  updateTask(id, update);
  emit(id);
}

export function cancelTask(id: string): boolean {
  if (!abortTask(id)) return false;
  const p = getTask(id);
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
  removeModelMappingByTaskId(id);
  logger.info('download canceled', { taskId: id });
  return true;
}

export async function downloadModelByName(
  modelName: string,
  downloadUrl: string,
  outputPath: string,
  taskId: string,
  opts: { source?: string; authHeaders?: Record<string, string> } = {},
): Promise<void> {
  const progress = getTask(taskId);
  if (!progress) throw new Error(`Progress record missing for task ${taskId}`);
  progress.status = 'downloading';
  progress.startTime = Date.now();
  progress.abortController = new AbortController();
  emit(taskId);

  const historyId = randomUUID();
  history.addHistoryItem({
    id: historyId, modelName, status: 'downloading', startTime: Date.now(),
    source: opts.source, savePath: outputPath, downloadUrl, taskId,
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

// Retry policy for network-level failures. HF's xethub CDN routinely drops
// long-running connections (~10min); without retry, a single `aborted` kills
// a 9 GB download that was 40% done. Retries are safe because the engine
// already resumes via Range header off the `.download` temp file.
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

function shouldRetryError(err: unknown, progress: DownloadProgress): boolean {
  // User cancel takes precedence — never retry.
  if (progress.canceled) return false;
  if (progress.abortController?.signal.aborted) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // HTTP 4xx will not succeed on retry (auth, 404, etc).
  if (/^HTTP 4\d\d$/.test(msg)) return false;
  // Malformed redirect from upstream — retrying same URL produces the same response.
  if (msg.includes('redirect') && msg.includes('missing location')) return false;
  if (msg === 'download canceled' || msg === 'download canceled by callback') return false;
  // Retryable: OS socket errors commonly seen on dropped CDN connections.
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) {
    return true;
  }
  // Retryable: engine-emitted messages for transient failures.
  if (msg === 'aborted' || msg.includes('socket timeout') || msg.includes('request timeout') || msg.includes('premature close')) {
    return true;
  }
  return false;
}

/** Sleep `ms`, but wake early (rejecting) if the user cancels the task. */
function sleepOrCancel(ms: number, progress: DownloadProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = progress.abortController?.signal;
    if (signal?.aborted) { reject(new Error('download canceled')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('download canceled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function runEngine(
  url: string, outputPath: string, taskId: string,
  progress: DownloadProgress, authHeaders: Record<string, string> | undefined,
): Promise<void> {
  const onEngineProgress = (percent: number, downloaded: number, total: number): void => {
    progress.currentModelProgress = percent;
    progress.overallProgress = percent;
    progress.downloadedBytes = downloaded;
    progress.totalBytes = total;
    const now = Date.now();
    if (!progress.lastLogTime || now - progress.lastLogTime > 200) {
      emit(taskId);
      progress.lastLogTime = now;
    }
  };
  const engineOptions = {
    abortController: progress.abortController || new AbortController(),
    onProgress: () => { /* engine calls the positional cb above */ },
    authHeaders,
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      await downloadFile(url, outputPath, onEngineProgress, engineOptions, progress);
      if (attempt > 1) logger.info('download succeeded after retry', { attempt, url });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_ATTEMPTS || !shouldRetryError(err, progress)) throw err;
      const delay = Math.round(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 500);
      logger.warn('download retry scheduled', {
        attempt, maxAttempts: RETRY_ATTEMPTS, delayMs: delay,
        message: err instanceof Error ? err.message : String(err),
      });
      await sleepOrCancel(delay, progress);
    }
  }
  throw lastErr;
}

function markCompleted(progress: DownloadProgress, taskId: string): void {
  progress.status = 'completed';
  progress.completed = true;
  progress.overallProgress = 100;
  progress.currentModelProgress = 100;
  emit(taskId);
  scheduleEvict(taskId);
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
  err: unknown, progress: DownloadProgress, taskId: string,
  modelName: string, historyId: string,
): void {
  if (progress.canceled) {
    logger.info('download canceled mid-stream', { model: modelName });
    history.updateHistoryItem(historyId, {
      status: 'canceled', endTime: Date.now(),
      downloadedSize: progress.downloadedBytes, fileSize: progress.totalBytes, speed: progress.speed,
    });
    emit(taskId);
    scheduleEvict(taskId);
    return;
  }
  progress.status = 'error';
  progress.error = err instanceof Error ? err.message : String(err);
  emit(taskId);
  // Release the filename→taskId mapping so the next install click creates a
  // fresh task instead of hitting the dedup short-circuit in downloadCustom.
  // Without this, a failed task pins the mapping forever and Resume/Retry is
  // silently a no-op (returns the old errored task ID). Cancel path already
  // does this (cancelTask above); error path used to leak.
  removeModelMappingByTaskId(taskId);
  history.updateHistoryItem(historyId, {
    status: 'failed', endTime: Date.now(), error: progress.error,
    downloadedSize: progress.downloadedBytes, fileSize: progress.totalBytes, speed: progress.speed,
  });
  logger.error('download failed', { model: modelName, message: progress.error });
  scheduleEvict(taskId);
}
