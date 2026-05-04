// Unified thumbnail dispatcher. Three entry points — URL mode, gallery DB
// mode, and template-asset mode — all converge on a pipeline chosen by
// file extension (URL/gallery) or fixed (template). Missing-source errors
// are caught here and translated into a `transient` placeholder result so
// the route layer can serve `Cache-Control: no-store` instead of 4xx.

import * as galleryRepo from '../../lib/db/gallery.repo.js';
import { resolveViewPath } from '../../lib/viewPath.js';
import { thumbnailForLocalImage, thumbnailForRemoteImage } from './pipelines/image.js';
import { thumbnailForLocalVideo } from './pipelines/video.js';
import { thumbnailForLocalAudio, thumbnailForRemoteAudio } from './pipelines/audio.js';
import { inlineBoxSvg, thumbnailPlaceholder } from './pipelines/static.js';
import { queryFromPrompt } from './pexels.js';
import {
  filenameFromUrl, filenameStem, pipelineForFilename,
} from './extension.js';
import { isThumbError, validateWidth } from './types.js';
import type { ThumbError, ThumbResult } from './types.js';

export { thumbnailForTemplateAsset } from './pipelines/template.js';

// Error codes that mean "we couldn't find or fetch the source bytes" — the
// caller's upstream is missing or unreadable, but the request itself was
// well-formed. These map to the placeholder fallback. Validation errors
// (INVALID_WIDTH, INVALID_URL, HOST_NOT_ALLOWED, INVALID_PATH) and
// pipeline errors (FFMPEG_FAILED) keep their existing 4xx/5xx behaviour.
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

async function dispatchGalleryItem(
  args: GalleryModeArgs,
): Promise<ThumbResult> {
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
 * Missing-source errors (deleted row, on-disk file gone, unsupported
 * extension, ffmpeg missing) collapse to the placeholder result so tile
 * grids degrade gracefully. Validation + pipeline-runtime errors propagate.
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
  if (pipeline === 'video') {
    // Remote-video thumbnailing would require streaming the file to a tmp
    // path + running ffmpeg on it; no caller needs that today.
    throw { code: 'UNSUPPORTED_EXTENSION' } satisfies ThumbError;
  }
  throw { code: 'UNSUPPORTED_EXTENSION' } satisfies ThumbError;
}

/**
 * URL mode. No DB context — extension drives the pipeline. A 404 (or any
 * other UPSTREAM_FAILED) collapses to the placeholder. Validation errors
 * (HOST_NOT_ALLOWED, INVALID_WIDTH, INVALID_URL) keep their 400 status.
 */
export async function thumbnailForUrl(args: UrlModeArgs): Promise<ThumbResult> {
  try {
    return await dispatchUrl(args);
  } catch (err) {
    if (isPlaceholderError(err)) return thumbnailPlaceholder();
    throw err;
  }
}
