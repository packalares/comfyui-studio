// Public façade for download tracking.
//
// Owns identity/queue dedup, capacity limits, and the WS broadcaster.
// The engine (controller.ts) drives bytes; this module tracks which downloads
// are visible to the UI and queues excess requests when at capacity.

import { matchesIdentity } from '../../lib/identity.js';
import { getTaskProgress, setProgressListener } from './controller.js';
import * as models from '../models/service.js';
import * as settings from '../settings/index.js';
import { RateLimitError } from '../../lib/errors.js';
import type { DownloadState, DownloadIdentity } from '../../contracts/system.contract.js';

export type { DownloadState, DownloadIdentity };

interface Entry {
  state: DownloadState;
}

const active = new Map<string, Entry>();
let broadcaster: ((message: object) => void) | null = null;

// Concurrency cap for simultaneous downloads. Sourced from env (default 2).
// Concurrency is now a user-tunable setting (settings.getDownloadsMaxConcurrent),
// falling back to env.MAX_CONCURRENT_DOWNLOADS when unset. Read it at each
// check so a Save in the UI takes effect immediately without restart.

interface QueuedRequest {
  synthId: string;
  hfUrl: string;
  modelDir: string;
  modelName?: string;
  filename?: string;
  /** Per-request tokens captured at enqueue time. Take precedence over the
   *  settings-layer token when the user supplied a one-off token in the body. */
  hfToken?: string;
  civitaiToken?: string;
}
const queue: QueuedRequest[] = [];

export function setDownloadBroadcaster(fn: (message: object) => void) {
  broadcaster = fn;
}

// Wire the controller so every engine update also pumps a WS broadcast
// via this service's emitter. Kept in a small hook so tests can opt out.
setProgressListener((taskId) => {
  const entry = active.get(taskId);
  if (!entry) return;
  void pollOnce(taskId);
});

function emit(message: object) {
  if (broadcaster) broadcaster(message);
}

export function getAllDownloads(): DownloadState[] {
  return Array.from(active.values()).map(e => e.state);
}

// Launcher returns progress as 0-1 fraction; normalize to 0-100 percentage for the UI.
function toPercent(v: number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  return v <= 1 ? v * 100 : v;
}

async function pollOnce(taskId: string): Promise<void> {
  const entry = active.get(taskId);
  if (!entry) return;
  const data = getTaskProgress(taskId);
  if (!data) return;
  const next: DownloadState = {
    ...entry.state,
    progress: toPercent(data.overallProgress) ?? entry.state.progress,
    currentModelProgress: toPercent(data.currentModelProgress) ?? entry.state.currentModelProgress,
    totalBytes: data.totalBytes ?? entry.state.totalBytes,
    downloadedBytes: data.downloadedBytes ?? entry.state.downloadedBytes,
    speed: data.speed ?? entry.state.speed,
    status: data.status ?? entry.state.status,
    completed: !!data.completed || data.status === 'completed',
    error: data.error ?? entry.state.error,
  };

  // Skip broadcast when nothing observable changed. Terminal transitions always emit
  // so the UI flips the status badge even if bytes haven't moved.
  const prev = entry.state;
  const isTerminal = next.completed || next.status === 'completed' || next.status === 'error';
  const changed =
    isTerminal ||
    next.downloadedBytes !== prev.downloadedBytes ||
    next.totalBytes !== prev.totalBytes ||
    next.progress !== prev.progress ||
    next.status !== prev.status ||
    next.error !== prev.error;

  entry.state = next;
  if (changed) emit({ type: 'download', data: next });
  if (isTerminal) {
    stopTracking(taskId);
  }
}

export function findByIdentity(id: DownloadIdentity): DownloadState | undefined {
  for (const entry of active.values()) {
    if (matchesIdentity(entry.state, id)) return entry.state;
  }
  return undefined;
}

export function trackDownload(taskId: string, id: DownloadIdentity = {}): void {
  if (active.has(taskId)) return;
  const state: DownloadState = {
    taskId,
    modelName: id.modelName,
    filename: id.filename,
    progress: 0,
    currentModelProgress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    status: 'downloading',
    completed: false,
    error: null,
  };
  active.set(taskId, { state });
  emit({ type: 'download', data: state });
  // Kick an immediate poll so the first progress snapshot arrives without waiting
  // for the next engine callback.
  void pollOnce(taskId);
}

export function stopTracking(taskId: string): void {
  const entry = active.get(taskId);
  if (!entry) return;
  active.delete(taskId);
  emit({ type: 'download', data: { ...entry.state, completed: true } });
  void tryDequeue();
}

export function isAtCapacity(): boolean {
  return active.size >= settings.getDownloadsMaxConcurrent();
}

/**
 * Re-evaluate the queue immediately. Used after the operator raises the
 * concurrent-downloads cap via Settings: previously-waiting items become
 * eligible for slots, and without this kick they'd sit until the next
 * natural state change (a completion or a new enqueue).
 */
export function kickQueue(): void {
  void tryDequeue();
}

export function findQueuedByIdentity(id: DownloadIdentity): QueuedRequest | undefined {
  return queue.find(q => matchesIdentity(q, id));
}

/** Enqueue a download request; returns the synthetic task id the UI will see.
 *
 * Backpressure: when the wait queue is already at the user-configurable cap
 * (`settings.getDownloadsMaxQueue()`), reject with a RateLimitError so the
 * UI can surface a "queue full, try again later" toast instead of silently
 * growing memory. Concurrency (MAX_CONCURRENT_DOWNLOADS) is enforced
 * separately by `isAtCapacity()`. */
export function enqueueDownload(req: Omit<QueuedRequest, 'synthId'>): string {
  const cap = settings.getDownloadsMaxQueue();
  if (queue.length >= cap) {
    throw new RateLimitError(
      `Download queue is full (${queue.length}/${cap}). Try again once some in-flight downloads finish.`,
    );
  }
  const synthId = 'queued_' + Math.random().toString(36).slice(2, 10);
  queue.push({ synthId, ...req });
  const state: DownloadState = {
    taskId: synthId,
    modelName: req.modelName,
    filename: req.filename,
    progress: 0,
    currentModelProgress: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    speed: 0,
    status: 'queued',
    completed: false,
    error: null,
  };
  emit({ type: 'download', data: state });
  return synthId;
}

/** Try to pull the next queued request and kick it off via the local service. */
async function tryDequeue(): Promise<void> {
  if (active.size >= settings.getDownloadsMaxConcurrent()) return;
  const next = queue.shift();
  if (!next) return;
  try {
    // Prefer per-request tokens captured at enqueue time (supplied by the user
    // in the POST body). Fall back to the settings-layer persisted token so
    // queued items still work when the body carried no token.
    const tokens = {
      hfToken: next.hfToken || settings.getHfToken(),
      civitaiToken: next.civitaiToken || settings.getCivitaiToken(),
    };
    const out = await models.downloadCustom(next.hfUrl, next.modelDir, tokens, next.filename);
    // The real taskId's broadcasts take over from here. We DON'T emit a
    // retirement for the synthetic placeholder — the frontend deduplicates
    // by (modelName, filename) when a new `downloading` event arrives with
    // a different taskId, so the synth entry is dropped cleanly without
    // flashing a fake "completed / 0%" frame to the UI.
    trackDownload(out.taskId, { modelName: next.modelName, filename: next.filename });
  } catch (err) {
    emit({
      type: 'download',
      data: {
        taskId: next.synthId, modelName: next.modelName, filename: next.filename,
        progress: 0, currentModelProgress: 0, totalBytes: 0, downloadedBytes: 0, speed: 0,
        status: 'error', completed: true, error: String(err),
      },
    });
    void tryDequeue();
  }
}
