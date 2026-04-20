// Canonical shapes for system status, queue state, and download progress.

export interface QueueStatus {
  queue_running: number;
  queue_pending: number;
}

/** Loose shape — we forward ComfyUI's `/api/system_stats` verbatim plus our own queue+gallery. */
export interface SystemInfo {
  queue: QueueStatus | null;
  gallery: { total: number; recent: unknown[] };
  [key: string]: unknown;
}

/** What `/api/launcher/status` returns to the frontend. */
export interface LauncherStatus {
  reachable?: boolean;
  status?: number | string;
  uptime?: string;
  error?: string;
  [key: string]: unknown;
}

/** One in-progress (or recently-finished) download, broadcast over WS and served by `GET /api/downloads`. */
export interface DownloadState {
  taskId: string;
  modelName?: string;
  filename?: string;
  progress: number;
  currentModelProgress: number;
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  status: string;
  completed: boolean;
  error: string | null;
}

export interface DownloadIdentity {
  modelName?: string;
  filename?: string;
}
