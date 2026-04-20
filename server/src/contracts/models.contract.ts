// Canonical model-related shapes.
//
// The studio already defines `LauncherModelEntry` and related types in
// `generation.contract.ts`. Keep those as the canonical scan / catalog
// contracts and add here only the download/progress shapes plus the
// essential-model metadata that the launcher's controllers return.
//
// Callers MUST import model shapes from this file (or
// `generation.contract.ts`) — no other file may re-declare `ModelInfo`,
// `EssentialModel`, etc.

/** URL options for a downloadable model (mirror + canonical source). */
export interface ModelSourceUrls {
  hf?: string;
  mirror?: string;
  cdn?: string;
}

/** Minimal model descriptor used by the downloader. */
export interface ModelInfo {
  id: string;
  name: string;
  type: string;
  /** Relative path under ComfyUI's `models/` tree. */
  dir: string;
  /** Output filename on disk. */
  out: string;
  url: ModelSourceUrls;
  description?: string;
  essential?: boolean;
}

/**
 * Extended descriptor for "essential" models pre-listed by the launcher.
 * Differs from `ModelInfo` only in that both URL sources are required.
 */
export interface EssentialModel extends Omit<ModelInfo, 'url'> {
  url: {
    hf: string;
    mirror: string;
  };
  size?: string;
  essential: true;
}

/** Lifecycle status for a download operation. */
export type DownloadStatus = 'downloading' | 'completed' | 'error' | 'canceled';

/** Live progress snapshot, updated as the downloader streams bytes. */
export interface DownloadProgress {
  currentModel: EssentialModel | null;
  currentModelIndex: number;
  overallProgress: number;
  currentModelProgress: number;
  completed: boolean;
  error: string | null;
  downloadedBytes: number;
  totalBytes: number;
  speed: number;
  status: DownloadStatus;
  startTime?: number;
  lastUpdateTime?: number;
  lastBytes?: number;
  abortController?: AbortController;
  canceled?: boolean;
  cancelTime?: number;
  startBytes?: number;
  lastLogTime?: number;
}

/** Options accepted by the core downloader (both single and batch). */
export interface DownloadOptions {
  abortController: AbortController;
  onProgress: (progress: DownloadProgress) => void;
  source?: string;
  basePath?: string;
  /** Request headers forwarded to HEAD + GET (used for gated HF auth). */
  authHeaders?: Record<string, string>;
}
