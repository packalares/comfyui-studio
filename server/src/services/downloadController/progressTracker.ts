// Per-task download progress state.
//
// Every download opens a `DownloadProgress` record keyed by taskId. The engine
// (`lib/download`) mutates this record directly while streaming bytes, and
// higher-level services read snapshots of it for the /progress endpoint and
// for WebSocket broadcasts.
//
// Kept deliberately small: no I/O, no broadcasting. The orchestrator wires
// updates to the broadcaster.

import { randomUUID } from 'crypto';
import { createDownloadProgress } from '../../lib/download/index.js';
import type { DownloadProgress } from '../../contracts/models.contract.js';

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
