// Per-task progress state for plugin install/uninstall/enable/disable/switch.
// Mirrors launcher's `plugin/progress.ts` API surface 1:1 so the preserved
// `/plugins/progress/:taskId` endpoint shape does not drift.

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
