// Canonical shapes for generation output and model dependency resolution.

import type { MediaType } from '../lib/mediaType.js';

/**
 * Slim row shape returned by the gallery list endpoints. Wave P split the
 * list payload from the full row so the tile grid no longer pulls 2-10 KB
 * of `workflowJson` / `promptText` / KSampler params per item — those fat
 * fields are only fetched by the detail modal via `GET /api/gallery/:id`.
 *
 * Every caller that previously handled a `GalleryItem[]` can keep treating
 * rows as the union below (slim fields always present, fat fields optional).
 */
export interface GalleryListItem {
  id: string;
  filename: string;
  subfolder: string;
  type: string;
  mediaType: string;
  url: string;
  promptId: string;
  templateName?: string | null;
  sizeBytes?: number | null;
  /**
   * Row creation timestamp (epoch ms). Present on repo rows; optional on the
   * over-the-wire contract so older consumers that only typed the tile subset
   * keep compiling.
   */
  createdAt?: number;
}

export interface GalleryItem extends GalleryListItem {
  /**
   * Optional generation metadata captured at execution time from ComfyUI's
   * history entry. Wave F adds these; rows written before Wave F have them
   * all null/undefined. `workflowJson` is the full API-format workflow
   * object stringified — required for the regenerate endpoint. Wave P moved
   * these off the list payload; only `GET /api/gallery/:id` returns them.
   */
  workflowJson?: string | null;
  promptText?: string | null;
  negativeText?: string | null;
  seed?: number | null;
  model?: string | null;
  sampler?: string | null;
  steps?: number | null;
  cfg?: number | null;
  width?: number | null;
  height?: number | null;
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
