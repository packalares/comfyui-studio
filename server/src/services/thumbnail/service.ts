// Unified thumbnail dispatcher. Two entry points — one per route shape —
// both converge on a pipeline chosen by file extension.

import * as galleryRepo from '../../lib/db/gallery.repo.js';
import { resolveViewPath } from '../../lib/viewPath.js';
import { thumbnailForLocalImage, thumbnailForRemoteImage } from './pipelines/image.js';
import { thumbnailForLocalVideo } from './pipelines/video.js';
import { thumbnailForLocalAudio, thumbnailForRemoteAudio } from './pipelines/audio.js';
import { inlineBoxSvg } from './pipelines/static.js';
import { queryFromPrompt } from './pexels.js';
import {
  filenameFromUrl, filenameStem, pipelineForFilename,
} from './extension.js';
import { validateWidth } from './types.js';
import type { ThumbError, ThumbResult } from './types.js';

export interface GalleryModeArgs {
  galleryId: string;
  width: number;
}

export interface UrlModeArgs {
  url: string;
  width: number;
}

/** Gallery-id mode. Loads the row, reconstructs the absolute path, dispatches. */
export async function thumbnailForGalleryItem(
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

/** URL mode. No DB context — extension drives the pipeline. */
export async function thumbnailForUrl(args: UrlModeArgs): Promise<ThumbResult> {
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
    // path + running ffmpeg on it; no caller needs that today. Return 404.
    throw { code: 'UNSUPPORTED_EXTENSION' } satisfies ThumbError;
  }
  // Unknown extension: 404 — matches the spec's decision table.
  throw { code: 'UNSUPPORTED_EXTENSION' } satisfies ThumbError;
}
