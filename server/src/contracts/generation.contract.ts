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
  /**
   * Generation wall-clock duration in milliseconds (captured from ComfyUI
   * status messages at write time). Surfaced on slim rows so the tile grid
   * can render a duration pill on audio/video items. Null on images and on
   * rows older than Wave F. Renamed from `durationMs` in v21 to disambiguate
   * from `mediaDurationMs` (length of the actual file).
   */
  jobDurationMs?: number | null;
  /**
   * Whether the user has starred this gallery item. Backed by the
   * `gallery.favorite` column (v22). Toggle via PUT /gallery/:id/favorite.
   * False on un-starred items and on rows that pre-date v22.
   */
  favorite?: boolean;
}

/**
 * Workflow recipe — derived on-the-fly from `workflowJson` via
 * `extractMetadata` at request time, then bundled under one key on the wire.
 * Null on rows without a stored workflow (disk-sweep, pre-Wave-F imports).
 * Replaces the 14 scattered top-level fields that used to live on GalleryItem
 * before v21 — same data, one bundle, easier null-check.
 */
export interface WorkflowDetail {
  promptText: string | null;
  negativeText: string | null;
  seed: number | null;
  model: string | null;
  models: string[];
  sampler: string | null;
  scheduler: string | null;
  steps: number | null;
  cfg: number | null;
  denoise: number | null;
  /** What the workflow asked for. The actual rendered dimensions live on `mediaInfo`. */
  width: number | null;
  height: number | null;
  lengthFrames: number | null;
  fps: number | null;
  batchSize: number | null;
}

export interface GalleryItem extends GalleryListItem {
  /**
   * Length of the media file itself (video/audio duration). Distinct from
   * `jobDurationMs` which is the wall-clock generation time. Populated by
   * `inspectFile` via ffprobe; null on images and when ffprobe is unavailable.
   */
  mediaDurationMs?: number | null;
  /**
   * Per-media inspection blob (parsed from `mediaInfoJson`). For images:
   * `{ width, height, format, channels?, hasAlpha? }`. For video:
   * `{ width, height, fps, codec_name, pix_fmt? }`. For audio:
   * `{ codec_name, sample_rate, channels, bit_rate? }`. Null otherwise.
   */
  mediaInfo?: Record<string, unknown> | null;
  /**
   * Workflow recipe derived from the stored `workflowJson`. Null when no
   * workflow was captured for this row. UI uses `Boolean(workflowDetail)`
   * as the regenerate-enabled gate.
   */
  workflowDetail?: WorkflowDetail | null;
  /** ID of the visually-previous item in the gallery (respects filter+sort). Null at boundary. */
  prevId?: string | null;
  /** ID of the visually-next item in the gallery (respects filter+sort). Null at boundary. */
  nextId?: string | null;
}

/**
 * Internal storage shape: GalleryItem plus the raw DB-only fields used by
 * routes that need the workflow string itself (regenerate, on-the-fly
 * detail parsing). NOT sent over the wire — routes strip these before
 * res.json.
 */
export interface GalleryRowFull extends GalleryItem {
  workflowJson?: string | null;
  workflowHash?: string | null;
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
  /** Discriminator for the union with `RequiredPluginInfo`. Always `'model'`
   *  on instances of this type — kept optional for back-compat with stored
   *  rows pre-redesign. New code on both ends should set + read it. */
  kind?: 'model';
  name: string;
  directory: string;
  url: string;
  /**
   * HuggingFace repo id (e.g. `IndexTeam/IndexTTS-2`). Present instead of
   * `url` when the entry represents a whole-repo download — the UI renders
   * "Download repo from HF" and the server shells out to `huggingface-cli
   * download <hfRepo> --local-dir <directory>`. `url` stays empty here
   * since there's no single-file artifact.
   */
  hfRepo?: string;
  size?: number;
  /** Pretty-formatted size string (e.g. "9.14 GB"), derived from catalog's size_bytes. */
  size_pretty?: string;
  installed: boolean;
  gated?: boolean;
  gated_message?: string;
}

/**
 * Per-class-type plugin row returned from `POST /api/check-dependencies`.
 *
 * One entry per workflow class_type that no installed plugin provides. The
 * `repos` list carries every candidate plugin that ships this class — usually
 * one, but a class_type can appear in multiple plugins (forks, re-exports).
 * `subgraphName` is the parent subgraph's display name when the missing
 * class lives inside a wrapper, or `null` for top-level nodes.
 */
export interface RequiredPluginInfo {
  kind: 'plugin';
  /** Workflow node class_type (e.g. `DrawViTPose`). */
  classType: string;
  /** Subgraph name the class_type was found in, or null when at top level. */
  subgraphName: string | null;
  /** Candidate repos. `[]` means class_type wasn't resolved by any registry. */
  repos: Array<{ repo: string; title: string; cnr_id?: string }>;
  installed: boolean;
}

export type RequiredItem = RequiredModelInfo | RequiredPluginInfo;
