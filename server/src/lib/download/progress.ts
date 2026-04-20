// Progress-tracker helpers for the download engine.
//
// These are intentionally tiny — the state machine lives in `engine.ts`.
// Keeping the shape + factory here lets contracts + tests import a stable
// type without pulling in the http module graph.
import type { DownloadProgress } from '../../contracts/models.contract.js';

export function createDownloadProgress(): DownloadProgress {
  return {
    currentModel: null,
    currentModelIndex: 0,
    overallProgress: 0,
    currentModelProgress: 0,
    completed: false,
    error: null,
    downloadedBytes: 0,
    totalBytes: 0,
    speed: 0,
    status: 'downloading',
  };
}

/** Bytes/sec given a byte count and a wall-clock start time (ms). */
export function calculateSpeed(bytesDownloaded: number, startTimeMs: number): number {
  const elapsedSeconds = (Date.now() - startTimeMs) / 1000;
  return elapsedSeconds > 0 ? bytesDownloaded / elapsedSeconds : 0;
}

/** Pretty-print a byte count. Matches launcher's `formatFileSize`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
