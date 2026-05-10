// Unified thumbnail dispatcher: extension mapping + entry points.
// Three modes — URL, gallery DB, template — dispatch into a pipeline chosen
// by file extension (URL/gallery) or fixed (template).
// Types live in types.ts (leaf) to avoid a cycle back from the pipelines.

import * as galleryRepo from '../../lib/db/gallery.repo.js';
import { resolveViewPath } from '../../lib/viewPath.js';
import { thumbnailForLocalImage, thumbnailForRemoteImage } from './pipelines/image.js';
import { thumbnailForLocalVideo } from './pipelines/video.js';
import { thumbnailForLocalAudio, thumbnailForRemoteAudio, queryFromPrompt } from './pipelines/audio.js';
import { inlineBoxSvg, thumbnailPlaceholder } from './pipelines/static.js';
import {
  isThumbError, validateWidth,
} from './types.js';
import type { ThumbResult, ThumbError, ThumbPipeline } from './types.js';

export { thumbnailForTemplateAsset } from './pipelines/template.js';
export * from './types.js';

// ── Extension → pipeline mapping ─────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'aac']);
const THREE_D_EXTS = new Set(['glb', 'gltf', 'usdz', 'obj']);

export function extensionOf(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot < 0) return '';
  return filename.slice(lastDot + 1).toLowerCase().split('?')[0].split('#')[0];
}

export function pipelineForFilename(filename: string): ThumbPipeline {
  const ext = extensionOf(filename);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (THREE_D_EXTS.has(ext)) return 'static3d';
  return 'unknown';
}

/** Pull the last URL path segment (pre-query) for extension sniffing. */
export function filenameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/');
    return segs[segs.length - 1] || '';
  } catch {
    return rawUrl.split('?')[0].split('#')[0].split('/').pop() ?? '';
  }
}

/** `foo.mp3` -> `foo`. Used as the Pexels fallback query when no prompt text. */
export function filenameStem(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

// Error codes that mean "source is missing/unreadable" — map to placeholder.
// Validation errors (INVALID_*) and pipeline-runtime errors keep 4xx/5xx.
const PLACEHOLDER_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'DB_LOOKUP_FAILED',
  'UPSTREAM_FAILED',
  'UNSUPPORTED_EXTENSION',
  'FFMPEG_MISSING',
]);

function isPlaceholderError(err: unknown): boolean {
  return isThumbError(err) && PLACEHOLDER_CODES.has(err.code);
}

export interface GalleryModeArgs {
  galleryId: string;
  width: number;
}

export interface UrlModeArgs {
  url: string;
  width: number;
}

async function dispatchGalleryItem(args: GalleryModeArgs): Promise<ThumbResult> {
  const width = validateWidth(args.width);
  let row;
  try { row = galleryRepo.getByIdFull(args.galleryId); }
  catch (err) {
    throw {
      code: 'DB_LOOKUP_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ThumbError;
  }
  if (!row) throw { code: 'NOT_FOUND' } satisfies ThumbError;

  const resolved = resolveViewPath(row.filename, row.subfolder ?? '', row.type ?? 'output');
  if (!resolved) throw { code: 'NOT_FOUND' } satisfies ThumbError;

  const pipeline = pipelineForFilename(row.filename);
  if (pipeline === 'image') return thumbnailForLocalImage(resolved.absPath, width);
  if (pipeline === 'video') return thumbnailForLocalVideo(resolved.absPath, width);
  if (pipeline === 'audio') {
    const query = queryFromPrompt(row.promptText) || queryFromPrompt(filenameStem(row.filename));
    return thumbnailForLocalAudio(resolved.absPath, width, query);
  }
  if (pipeline === 'static3d') return inlineBoxSvg();
  throw { code: 'UNSUPPORTED_EXTENSION' } satisfies ThumbError;
}

/**
 * Gallery-id mode. Loads the row, reconstructs the absolute path, dispatches.
 * Missing-source errors collapse to the placeholder. Validation + pipeline
 * errors propagate.
 */
export async function thumbnailForGalleryItem(
  args: GalleryModeArgs,
): Promise<ThumbResult> {
  try {
    return await dispatchGalleryItem(args);
  } catch (err) {
    if (isPlaceholderError(err)) return thumbnailPlaceholder();
    throw err;
  }
}

async function dispatchUrl(args: UrlModeArgs): Promise<ThumbResult> {
  const width = validateWidth(args.width);
  const filename = filenameFromUrl(args.url);
  const pipeline = pipelineForFilename(filename);
  if (pipeline === 'image') return thumbnailForRemoteImage(args.url, width);
  if (pipeline === 'audio') {
    return thumbnailForRemoteAudio(args.url, width, queryFromPrompt(filenameStem(filename)));
  }
  if (pipeline === 'static3d') return inlineBoxSvg();
  // Remote-video and unknown extensions are unsupported in URL mode.
  throw { code: 'UNSUPPORTED_EXTENSION' } satisfies ThumbError;
}

/**
 * URL mode. No DB context — extension drives the pipeline. A 404 (or any
 * UPSTREAM_FAILED) collapses to the placeholder. Validation errors keep 400.
 */
export async function thumbnailForUrl(args: UrlModeArgs): Promise<ThumbResult> {
  try {
    return await dispatchUrl(args);
  } catch (err) {
    if (isPlaceholderError(err)) return thumbnailPlaceholder();
    throw err;
  }
}
