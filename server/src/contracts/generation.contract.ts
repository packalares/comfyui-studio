// Canonical shapes for generation output and model dependency resolution.

import type { MediaType } from '../lib/mediaType.js';

export interface GalleryItem {
  id: string;
  filename: string;
  subfolder: string;
  type: string;
  mediaType: string;
  url: string;
  promptId: string;
}

/** One output row returned from `GET /api/history/:promptId`. */
export interface HistoryOutput {
  filename: string;
  subfolder: string;
  type: string;
  mediaType: MediaType;
}

/** Row returned from the launcher's `/api/models` scan. */
export interface LauncherModelEntry {
  name: string;
  type: string;
  filename: string;
  url: string;
  size?: string;
  fileSize?: number;
  installed: boolean;
  save_path?: string;
}

/** Per-model row returned from `POST /api/check-dependencies`. */
export interface RequiredModelInfo {
  name: string;
  directory: string;
  url: string;
  size?: number;
  /** Pretty-formatted size string (e.g. "9.14 GB"), derived from catalog's size_bytes. */
  size_pretty?: string;
  installed: boolean;
  gated?: boolean;
  gated_message?: string;
}
