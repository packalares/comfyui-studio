// Download history persistence.
//
// Ported from launcher's `DownloadController` history methods. Each entry
// records the lifecycle of a single download. Writes go through `atomicWrite`
// so a crash mid-save cannot truncate the file.

import fs from 'fs';
import path from 'path';
import { paths } from '../../config/paths.js';
import { atomicWrite, safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

export interface DownloadHistoryItem {
  id: string;
  modelName: string;
  status: 'success' | 'failed' | 'canceled' | 'downloading';
  statusText?: string;
  startTime: number;
  endTime?: number;
  fileSize?: number;
  downloadedSize?: number;
  error?: string;
  source?: string;
  speed?: number;
  savePath?: string;
  downloadUrl?: string;
  taskId?: string;
}

const MAX_HISTORY_ITEMS = 100;

/** The history file lives under the launcher data dir (default: bundled data). */
function historyFile(): string {
  return path.join(paths.dataDir, 'download-history.json');
}

let cache: DownloadHistoryItem[] | null = null;

function load(): DownloadHistoryItem[] {
  if (cache) return cache;
  const file = historyFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      cache = Array.isArray(parsed) ? parsed as DownloadHistoryItem[] : [];
      logger.info('download history loaded', { count: cache.length });
    } else {
      cache = [];
    }
  } catch (err) {
    logger.error('download history load failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    cache = [];
  }
  return cache;
}

function persist(): void {
  const data = cache ?? [];
  try {
    // Cap at MAX_HISTORY_ITEMS before writing.
    if (data.length > MAX_HISTORY_ITEMS) {
      cache = data.slice(-MAX_HISTORY_ITEMS);
    }
    // safeResolve verifies the file stays within paths.dataDir.
    const target = safeResolve(paths.dataDir, 'download-history.json');
    atomicWrite(target, JSON.stringify(cache ?? []));
  } catch (err) {
    logger.error('download history save failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function listHistory(): DownloadHistoryItem[] {
  return [...load()];
}

export function addHistoryItem(item: DownloadHistoryItem): void {
  const arr = load();
  const idx = arr.findIndex((r) => r.id === item.id);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...item };
  else arr.push(item);
  persist();
}

export function updateHistoryItem(
  id: string,
  updates: Partial<DownloadHistoryItem>,
): boolean {
  const arr = load();
  const idx = arr.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  arr[idx] = { ...arr[idx], ...updates };
  persist();
  return true;
}

export function deleteHistoryItem(id: string): DownloadHistoryItem | null {
  const arr = load();
  const idx = arr.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const [removed] = arr.splice(idx, 1);
  persist();
  return removed;
}

export function clearHistory(): void {
  cache = [];
  persist();
}

export function findHistoryByTaskId(taskId: string): DownloadHistoryItem | undefined {
  return load().find((item) => item.taskId === taskId);
}

/** For tests only. */
export function __resetForTests(): void {
  cache = [];
}
