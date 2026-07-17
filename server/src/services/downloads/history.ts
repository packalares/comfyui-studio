// Download history persistence.
//
// Each entry records the lifecycle of a single download. Writes go through
// `atomicWrite` so a crash mid-save cannot truncate the file.

import fs from 'fs';
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
  /** Final percent (0–100). Set to 100 on success, last-observed on
   *  canceled/failed. Lets the Recent/All tabs render a real progress bar
   *  instead of falling back to (downloaded/total)*100, which is 0 for rows
   *  the controller never updated mid-stream. */
  progress?: number;
}

const MAX_HISTORY_ITEMS = 100;

function historyFile(): string {
  return paths.downloadHistoryPath;
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
      const before = cache.length;
      cache = collapseDuplicates(cache);
      if (cache.length !== before) {
        logger.info('download history de-duplicated on load', {
          before, after: cache.length,
        });
        persist();
      } else {
        logger.info('download history loaded', { count: cache.length });
      }
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

/**
 * Collapse pre-existing duplicate rows that share a `taskId`. We used to
 * generate a fresh `id` per `addHistoryItem` call, so a double-invocation of
 * the download handler left two rows per task. Keep the row whose terminal
 * progress is richest (success > failed/canceled > downloading-with-bytes >
 * everything else).
 */
function collapseDuplicates(arr: DownloadHistoryItem[]): DownloadHistoryItem[] {
  const bestByTask = new Map<string, DownloadHistoryItem>();
  const withoutTaskId: DownloadHistoryItem[] = [];
  const score = (r: DownloadHistoryItem): number => {
    if (r.status === 'success') return 4;
    if (r.status === 'failed' || r.status === 'canceled') return 3;
    if (r.status === 'downloading' && (r.downloadedSize ?? 0) > 0) return 2;
    return 1;
  };
  for (const row of arr) {
    if (!row.taskId) { withoutTaskId.push(row); continue; }
    const prev = bestByTask.get(row.taskId);
    if (!prev || score(row) > score(prev)) bestByTask.set(row.taskId, row);
  }
  return [...bestByTask.values(), ...withoutTaskId];
}

function persist(): void {
  const data = cache ?? [];
  try {
    // Cap at MAX_HISTORY_ITEMS before writing.
    if (data.length > MAX_HISTORY_ITEMS) {
      cache = data.slice(-MAX_HISTORY_ITEMS);
    }
    // safeResolve verifies the file stays within the runtime-state dir.
    const target = safeResolve(paths.runtimeStateDir, 'download-history.json');
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
  // Exact-id match wins (re-insert of an existing row).
  const idxById = arr.findIndex((r) => r.id === item.id);
  if (idxById >= 0) {
    arr[idxById] = { ...arr[idxById], ...item };
    persist();
    return;
  }
  // Same-taskId match on an in-flight row → merge into it instead of
  // inserting a duplicate. Guards against double-click / strict-mode
  // double-invoke / handler re-entry creating parallel history rows for the
  // same underlying download task.
  if (item.taskId && item.status === 'downloading') {
    const idxByTask = arr.findIndex(
      (r) => r.taskId === item.taskId && r.status === 'downloading',
    );
    if (idxByTask >= 0) {
      arr[idxByTask] = { ...arr[idxByTask], ...item, id: arr[idxByTask].id };
      persist();
      return;
    }
  }
  arr.push(item);
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
