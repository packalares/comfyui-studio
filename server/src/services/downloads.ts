import { env } from '../config/env.js';
import { matchesIdentity } from '../lib/identity.js';
import { getTaskProgress, setProgressListener } from './downloadController/downloadController.service.js';
import * as models from './models/models.service.js';
import type { DownloadState, DownloadIdentity } from '../contracts/system.contract.js';

export type { DownloadState, DownloadIdentity };

interface Entry {
  state: DownloadState;
  timer: NodeJS.Timeout;
}

const active = new Map<string, Entry>();
let broadcaster: ((message: object) => void) | null = null;

// Concurrency cap for simultaneous downloads. Sourced from env (default 2).
const MAX_CONCURRENT = env.MAX_CONCURRENT_DOWNLOADS;

interface QueuedRequest {
  synthId: string;
  hfUrl: string;
  modelDir: string;
  modelName?: string;
  filename?: string;
}
const queue: QueuedRequest[] = [];

export function setDownloadBroadcaster(fn: (message: object) => void) {
  broadcaster = fn;
}

// Wire the downloadController so every engine update also pumps a WS broadcast
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
  entry.state = next;
  emit({ type: 'download', data: next });
  if (next.completed || next.status === 'completed' || next.status === 'error') {
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
  const timer = setInterval(() => { void pollOnce(taskId); }, 1500);
  active.set(taskId, { state, timer });
  emit({ type: 'download', data: state });
  // Kick an immediate poll so the first progress arrives fast.
  void pollOnce(taskId);
}

export function stopTracking(taskId: string): void {
  const entry = active.get(taskId);
  if (!entry) return;
  clearInterval(entry.timer);
  active.delete(taskId);
  emit({ type: 'download', data: { ...entry.state, completed: true } });
  void tryDequeue();
}

export function isAtCapacity(): boolean {
  return active.size >= MAX_CONCURRENT;
}

export function findQueuedByIdentity(id: DownloadIdentity): QueuedRequest | undefined {
  return queue.find(q => matchesIdentity(q, id));
}

/** Enqueue a download request; returns the synthetic task id the UI will see. */
export function enqueueDownload(req: Omit<QueuedRequest, 'synthId'>): string {
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
  if (active.size >= MAX_CONCURRENT) return;
  const next = queue.shift();
  if (!next) return;
  try {
    // Local `downloadCustom` accepts the HF token and wires `authHeaders` into
    // the engine. The launcher's `hfToken` body-field plumbing is no longer
    // needed since the download runs in-process.
    const out = await models.downloadCustom(next.hfUrl, next.modelDir);
    // Retire the synthetic placeholder; the real taskId's broadcasts take over from here.
    emit({
      type: 'download',
      data: {
        taskId: next.synthId, modelName: next.modelName, filename: next.filename,
        progress: 0, currentModelProgress: 0, totalBytes: 0, downloadedBytes: 0, speed: 0,
        status: 'completed', completed: true, error: null,
      },
    });
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
