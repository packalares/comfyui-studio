// Plugin install / uninstall / enable / disable / switch-version history.
// Mirrors launcher's `plugin/history.ts` 1:1 in terms of persisted shape and
// API semantics, but all writes go through `atomicWrite` and localization has
// been dropped (only English strings are emitted).

import fs from 'fs';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

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
