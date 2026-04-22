// Unified thumbnail service: shared types + error codes.
//
// Both URL shapes (`:galleryId` DB mode and `?url=` remote mode) dispatch
// into a pipeline (image / video / audio / static) that produces a webp
// under `<cacheRoot>/thumbs/<aa>/<md5>.webp`. 3D + audio-fallback bypass
// the on-disk cache since they emit deterministic inline SVG bytes.

export type ThumbPipeline = 'image' | 'video' | 'audio' | 'static3d' | 'unknown';

export interface ThumbFileResult {
  kind: 'file';
  filePath: string;
  contentType: string;
  cached: boolean;
}

export interface ThumbInlineResult {
  kind: 'inline';
  body: string | Buffer;
  contentType: string;
}

export type ThumbResult = ThumbFileResult | ThumbInlineResult;

export interface ThumbError {
  code:
    | 'INVALID_WIDTH'
    | 'NOT_FOUND'
    | 'HOST_NOT_ALLOWED'
    | 'UPSTREAM_FAILED'
    | 'FFMPEG_MISSING'
    | 'FFMPEG_FAILED'
    | 'UNSUPPORTED_EXTENSION'
    | 'DB_LOOKUP_FAILED';
  status?: number;
  detail?: string;
}

export function isThumbError(err: unknown): err is ThumbError {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && [
    'INVALID_WIDTH',
    'NOT_FOUND',
    'HOST_NOT_ALLOWED',
    'UPSTREAM_FAILED',
    'FFMPEG_MISSING',
    'FFMPEG_FAILED',
    'UNSUPPORTED_EXTENSION',
    'DB_LOOKUP_FAILED',
  ].includes(code);
}

export const MIN_WIDTH = 32;
export const MAX_WIDTH = 2048;

export function validateWidth(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw { code: 'INVALID_WIDTH' } satisfies ThumbError;
  }
  if (raw < MIN_WIDTH || raw > MAX_WIDTH) {
    throw { code: 'INVALID_WIDTH' } satisfies ThumbError;
  }
  return raw;
}
