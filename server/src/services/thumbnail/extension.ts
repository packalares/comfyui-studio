// Extension -> pipeline mapping shared by both URL shapes. The DB-mode
// route reads `mediaType` from sqlite but still falls back to extension for
// 3D asset detection (classified as `image` upstream to share the filter
// bucket); URL-mode has no DB context and relies purely on the extension.

import type { ThumbPipeline } from './types.js';

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
