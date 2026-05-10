// Plugin operation history (persistent JSON) and per-task progress state
// (in-memory). Both track the same set of operation types.

import fs from 'fs';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

// ---- History (persistent) ----

export type PluginOpType = 'install' | 'uninstall' | 'disable' | 'enable' | 'switch-version';
export type PluginOpStatus = 'running' | 'success' | 'failed';

export interface PluginOperationHistory {
  id: string;
  pluginId: string;
  pluginName?: string;
  type: PluginOpType;
  typeText?: string;
  startTime: number;
  endTime?: number;
  status: PluginOpStatus;
  statusText?: string;
  logs: string[];
  result?: string;
  githubProxy?: string;
}

const MAX_HISTORY_ITEMS = 100;
let items: PluginOperationHistory[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  try {
    if (fs.existsSync(paths.pluginHistoryPath)) {
      items = JSON.parse(fs.readFileSync(paths.pluginHistoryPath, 'utf-8')) as PluginOperationHistory[];
      if (!Array.isArray(items)) items = [];
    } else {
      items = [];
    }
  } catch (err) {
    logger.warn('plugin history load failed', { message: err instanceof Error ? err.message : String(err) });
    items = [];
  }
  loaded = true;
}

function save(): void {
  try {
    if (items.length > MAX_HISTORY_ITEMS) {
      items = items.slice(-MAX_HISTORY_ITEMS);
    }
    atomicWrite(paths.pluginHistoryPath, JSON.stringify(items, null, 2), { mode: 0o644 });
  } catch (err) {
    logger.error('plugin history save failed', { message: err instanceof Error ? err.message : String(err) });
  }
}

function describeOperation(type: PluginOpType): string {
  switch (type) {
    case 'install': return 'installing';
    case 'uninstall': return 'uninstalling';
    case 'disable': return 'disabling';
    case 'enable': return 'enabling';
    case 'switch-version': return 'switching version of';
  }
}

export function addHistoryItem(
  taskId: string,
  pluginId: string,
  type: PluginOpType,
  githubProxy?: string,
  pluginName?: string,
): PluginOperationHistory {
  load();
  const item: PluginOperationHistory = {
    id: taskId,
    pluginId,
    pluginName,
    type,
    startTime: Date.now(),
    status: 'running',
    logs: [`[${new Date().toLocaleString()}] Started ${describeOperation(type)} plugin ${pluginId}`],
    githubProxy,
  };
  items.unshift(item);
  save();
  return item;
}

export function updateHistoryItem(taskId: string, updates: Partial<PluginOperationHistory>): void {
  load();
  const target = items.find((i) => i.id === taskId);
  if (!target) return;
  Object.assign(target, updates);
  save();
}

export function appendLog(taskId: string, message: string): void {
  load();
  const target = items.find((i) => i.id === taskId);
  if (!target) return;
  target.logs.push(`[${new Date().toLocaleString()}] ${message}`);
  save();
}

export function getHistory(limit: number = 100): PluginOperationHistory[] {
  load();
  return items.slice(0, Math.max(0, limit));
}

export function getLogs(taskId: string): string[] | null {
  load();
  const target = items.find((i) => i.id === taskId);
  return target ? [...target.logs] : null;
}

export function clearHistory(): void {
  load();
  items = [];
  save();
}

export function deleteHistoryItem(taskId: string): PluginOperationHistory | null {
  load();
  const idx = items.findIndex((i) => i.id === taskId);
  if (idx === -1) return null;
  const [removed] = items.splice(idx, 1);
  save();
  return removed;
}

// ---- Progress (in-memory) ----

export type PluginTaskType = 'install' | 'uninstall' | 'disable' | 'enable' | 'switch-version';

export interface PluginTaskProgress {
  progress: number;
  completed: boolean;
  pluginId: string;
  type: PluginTaskType;
  message?: string;
  githubProxy?: string;
  logs?: string[];
}

const tasks: Record<string, PluginTaskProgress> = {};

export function createTask(
  taskId: string,
  pluginId: string,
  type: PluginTaskType,
  githubProxy?: string,
): void {
  tasks[taskId] = {
    progress: 0,
    completed: false,
    pluginId,
    type,
    githubProxy,
    logs: [],
  };
}

export function updateProgress(taskId: string, progress: number, message?: string): void {
  const t = tasks[taskId];
  if (!t) return;
  t.progress = progress;
  if (message !== undefined) t.message = message;
}

export function completeTask(taskId: string, success = true, message?: string): void {
  const t = tasks[taskId];
  if (!t) return;
  t.completed = true;
  t.progress = success ? 100 : 0;
  if (message !== undefined) t.message = message;
}

export function addLog(taskId: string, logMessage: string): void {
  const t = tasks[taskId];
  if (!t) return;
  t.logs = t.logs || [];
  t.logs.push(logMessage);
}

export function getTaskProgress(taskId: string): PluginTaskProgress | null {
  return tasks[taskId] ?? null;
}

export function getAllTasks(): Record<string, PluginTaskProgress> {
  return { ...tasks };
}

export function removeTask(taskId: string): void {
  delete tasks[taskId];
}

export function cleanupCompletedTasks(): number {
  let cleaned = 0;
  for (const id of Object.keys(tasks)) {
    if (tasks[id].completed) { delete tasks[id]; cleaned++; }
  }
  return cleaned;
}

export function getTaskStats(): {
  total: number;
  active: number;
  completed: number;
  byType: Record<string, number>;
} {
  const list = Object.values(tasks);
  const byType: Record<string, number> = {};
  for (const t of list) byType[t.type] = (byType[t.type] || 0) + 1;
  return {
    total: list.length,
    active: list.filter((t) => !t.completed).length,
    completed: list.filter((t) => t.completed).length,
    byType,
  };
}

export function taskExists(taskId: string): boolean {
  return taskId in tasks;
}

// Belt-and-braces periodic sweep: install schedules per-task removeTask in
// its finally block, but future code paths without that hook would leak here.
// Low-frequency, unref'd so it doesn't block process exit.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  cleanupCompletedTasks();
}, SWEEP_INTERVAL_MS).unref();
