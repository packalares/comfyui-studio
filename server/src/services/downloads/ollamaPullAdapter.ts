// Bridge between Ollama's model:pull:* chat events and the Downloads tab WS bus.
//
// Ollama's runPull() (chat/ollama.ts) emits model:pull:progress / model:pull:done /
// model:pull:error via emitChatEvent (chat broadcaster). Those events are WS-visible
// to the UI's ChatEvents handler but not to the Downloads tab, which only listens
// for { type: 'download', data: DownloadState }.
//
// This adapter intercepts those events and re-emits them in the DownloadState shape
// so the existing AppContext handler absorbs them with no client-side changes.
// The taskId prefix 'pull_' (set by ollama.ts:makePullId) lets the UI distinguish
// ollama pulls from comfy model downloads when source labeling is needed.

import type { DownloadState } from '../../contracts/system.contract.js';
import type { UnifiedDownload } from '../../contracts/downloads.contract.js';

export type { UnifiedDownload };

// The download broadcaster is set by index.ts (setDownloadBroadcaster). We hold
// a local reference so this module does not need to import facade.ts (no circular dep).
let bus: ((msg: object) => void) | null = null;

export function setOllamaPullBus(fn: ((msg: object) => void) | null): void {
  bus = fn;
}

function toDownloadState(dl: UnifiedDownload): DownloadState {
  const isTerminal = dl.status === 'success' || dl.status === 'failed' || dl.status === 'canceled';
  return {
    taskId: dl.id,
    modelName: dl.name,
    filename: undefined,
    progress: dl.progress?.percent ?? 0,
    currentModelProgress: dl.progress?.percent ?? 0,
    totalBytes: dl.progress?.total ?? 0,
    downloadedBytes: dl.progress?.bytes ?? 0,
    speed: 0,
    status: dl.status === 'success' ? 'completed' : dl.status === 'failed' ? 'error' : dl.status,
    completed: dl.status === 'success',
    error: dl.error ?? null,
    // Carry unified fields as extension fields so DownloadsTab can use them.
    source: dl.source,
    kind: dl.kind,
  } as DownloadState & { source: string; kind: string };
}

function emit(dl: UnifiedDownload): void {
  if (bus) bus({ type: 'download', data: toDownloadState(dl) });
}

// Keyed by Ollama taskId so in-progress pulls can be updated without re-emitting
// a full new entry. Status transitions: downloading -> success | failed | canceled.
const activePulls = new Map<string, UnifiedDownload>();

export function handleOllamaChatEvent(
  type: string,
  data: Record<string, unknown>,
): void {
  if (
    type !== 'model:pull:progress' &&
    type !== 'model:pull:done' &&
    type !== 'model:pull:error'
  ) return;

  const taskId = typeof data.taskId === 'string' ? data.taskId : null;
  const name = typeof data.name === 'string' ? data.name : '(unknown)';
  if (!taskId) return;

  if (type === 'model:pull:progress') {
    const percent =
      typeof data.percent === 'number' ? data.percent : undefined;
    const total =
      typeof data.total === 'number' ? data.total : undefined;
    const completed =
      typeof data.completed === 'number' ? data.completed : undefined;

    const prev = activePulls.get(taskId);
    const prevPercent = prev?.progress?.percent;
    const prevBytes = prev?.progress?.bytes;

    // Only emit when something meaningful changed.
    if (prev && prevPercent === percent && prevBytes === completed) return;

    const dl: UnifiedDownload = {
      id: taskId,
      source: 'ollama',
      kind: 'llm',
      name,
      status: 'downloading',
      progress: { bytes: completed ?? 0, total, percent },
      startedAt: prev?.startedAt ?? Date.now(),
    };
    activePulls.set(taskId, dl);
    emit(dl);
    return;
  }

  if (type === 'model:pull:done') {
    const prev = activePulls.get(taskId);
    const dl: UnifiedDownload = {
      id: taskId,
      source: 'ollama',
      kind: 'llm',
      name,
      status: 'success',
      progress: { bytes: prev?.progress?.total ?? 0, total: prev?.progress?.total, percent: 100 },
      startedAt: prev?.startedAt,
      finishedAt: Date.now(),
    };
    activePulls.delete(taskId);
    emit(dl);
    return;
  }

  if (type === 'model:pull:error') {
    const error = typeof data.error === 'string' ? data.error : 'pull failed';
    const prev = activePulls.get(taskId);
    const dl: UnifiedDownload = {
      id: taskId,
      source: 'ollama',
      kind: 'llm',
      name,
      status: 'failed',
      error,
      startedAt: prev?.startedAt,
      finishedAt: Date.now(),
    };
    activePulls.delete(taskId);
    emit(dl);
  }
}

/** For tests only. */
export function __resetForTests(): void {
  activePulls.clear();
}
