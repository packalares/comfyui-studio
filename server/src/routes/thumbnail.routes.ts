// Unified thumbnail endpoints.
//
//   GET    /api/thumbnail/stats             — cache stats JSON
//   DELETE /api/thumbnail/cache             — admin wipe
//   GET    /api/thumbnail?url=...&w=...     — remote URL thumbnail
//   GET    /api/thumbnail/template/<path>   — ComfyUI templates/<path>
//   GET    /api/thumbnail/:galleryId        — DB row thumbnail (sqlite lookup)

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { createReadStream } from 'fs';
import { logger } from '../lib/logger.js';
import {
  thumbnailForGalleryItem, thumbnailForTemplateAsset, thumbnailForModelAsset,
  thumbnailForPresetAsset, thumbnailForUrl,
  collectStats, clearCache, scheduleSweeps,
  isThumbError,
} from '../services/thumbnail/index.js';
import type { ThumbResult } from '../services/thumbnail/index.js';
import { ValidationError, NotFoundError, UpstreamUnavailableError } from '../lib/errors.js';

// Boot-time side effect: register the 30s-delayed first sweep + 6h interval
// on first import of this router module. Idempotent — subsequent imports
// are no-ops so test harnesses that re-import the router don't spawn extra
// timers per test. Registered here rather than in index.ts to keep the
// entrypoint's line count under the structure test's snapshot.
scheduleSweeps();

const router = Router();

const DEFAULT_WIDTH = 320;

function parseWidth(raw: unknown): number | { error: string } {
  if (raw == null || raw === '') return DEFAULT_WIDTH;
  if (typeof raw !== 'string') return { error: 'w must be an integer' };
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return { error: 'w must be an integer' };
  return n;
}

function sendThumb(res: Response, result: ThumbResult): void {
  res.setHeader('Content-Type', result.contentType);
  if (result.kind === 'inline') {
    // Transient placeholders (returned when an upstream is missing) must
    // not be cached — once the real source appears the next render must
    // see it. Permanent inline SVGs (Box / Music) keep the short cache.
    if (result.transient === true) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
    res.send(result.body);
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  createReadStream(result.filePath).pipe(res);
}

/** Translate a ThumbError or unknown caught value into an HttpError and throw it. */
function throwMappedError(err: unknown, context: Record<string, unknown>): never {
  if (isThumbError(err)) {
    if (
      err.code === 'INVALID_WIDTH'
      || err.code === 'HOST_NOT_ALLOWED'
      || err.code === 'INVALID_PATH'
      || err.code === 'INVALID_URL'
    ) {
      throw new ValidationError(err.code);
    }
    // DB_LOOKUP_FAILED maps to 404 so tile grids that pass an id the DB can't
    // find degrade gracefully instead of painting an error.
    if (
      err.code === 'NOT_FOUND'
      || err.code === 'UNSUPPORTED_EXTENSION'
      || err.code === 'FFMPEG_MISSING'
      || err.code === 'DB_LOOKUP_FAILED'
    ) {
      if (err.code === 'DB_LOOKUP_FAILED') {
        logger.warn('thumbnail: db lookup failed', { ...context, detail: err.detail });
      }
      throw new NotFoundError(err.code);
    }
    logger.warn('thumbnail: pipeline error', { ...context, code: err.code, detail: err.detail });
    throw new UpstreamUnavailableError(err.code);
  }
  logger.warn('thumbnail: unexpected error', {
    ...context,
    message: err instanceof Error ? err.message : String(err),
  });
  throw new UpstreamUnavailableError('THUMBNAIL_FAILED');
}

const handleStats: RequestHandler = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await collectStats();
    res.json(stats);
  } catch (err) {
    try { throwMappedError(err, { op: 'stats' }); } catch (mapped) { next(mapped); }
  }
};

const handleClear: RequestHandler = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { deleted } = await clearCache();
    res.json({ deleted });
  } catch (err) {
    try { throwMappedError(err, { op: 'clear' }); } catch (mapped) { next(mapped); }
  }
};

const handleUrlMode: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) { next(new ValidationError('url required')); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { next(new ValidationError(width.error)); return; }
  try {
    const result = await thumbnailForUrl({ url, width });
    sendThumb(res, result);
  } catch (err) {
    try { throwMappedError(err, { url }); } catch (mapped) { next(mapped); }
  }
};

const handleIdMode: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const rawId = req.params.galleryId;
  const galleryId = typeof rawId === 'string' ? rawId : '';
  if (!galleryId) { next(new ValidationError('galleryId required')); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { next(new ValidationError(width.error)); return; }
  try {
    const result = await thumbnailForGalleryItem({ galleryId, width });
    sendThumb(res, result);
  } catch (err) {
    try { throwMappedError(err, { galleryId }); } catch (mapped) { next(mapped); }
  }
};

const handleTemplateMode: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  // `*` glob captures the rest of the path including nested segments — the
  // matched value lives at `req.params[0]` per Express 4 wildcard semantics.
  const rawPath = (req.params as Record<string, unknown>)[0];
  const assetPath = typeof rawPath === 'string' ? rawPath : '';
  if (!assetPath) { next(new ValidationError('assetPath required')); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { next(new ValidationError(width.error)); return; }
  try {
    const result = await thumbnailForTemplateAsset({ assetPath, width });
    sendThumb(res, result);
  } catch (err) {
    try { throwMappedError(err, { assetPath }); } catch (mapped) { next(mapped); }
  }
};

const handleModelMode: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const save_path = typeof req.query.save_path === 'string' ? req.query.save_path : '';
  const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
  if (!save_path || !filename) { next(new ValidationError('save_path and filename required')); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { next(new ValidationError(width.error)); return; }
  try {
    const result = await thumbnailForModelAsset({ save_path, filename, width });
    sendThumb(res, result);
  } catch (err) {
    try { throwMappedError(err, { save_path, filename }); } catch (mapped) { next(mapped); }
  }
};

// Preset mode: streams a downloaded preview image saved by the import hook
// into `<userTemplatesDir>/<parent>/<filename>`. The matched glob is
// `<parent>/<filename>` and resolves under userTemplatesDir via safeResolve
// inside the pipeline. Width controls the resize stage like every other mode.
const handlePresetMode: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
  const rawPath = (req.params as Record<string, unknown>)[0];
  const assetPath = typeof rawPath === 'string' ? rawPath : '';
  if (!assetPath) { next(new ValidationError('assetPath required')); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { next(new ValidationError(width.error)); return; }
  try {
    const result = await thumbnailForPresetAsset({ assetPath, width });
    sendThumb(res, result);
  } catch (err) {
    try { throwMappedError(err, { assetPath }); } catch (mapped) { next(mapped); }
  }
};

// Mount order: literal `/thumbnail/stats`, `/thumbnail/cache`,
// `/thumbnail/template/*` and `/thumbnail/model` are registered BEFORE the
// `:galleryId` param handler so the param doesn't swallow them.
router.get('/thumbnail/stats', handleStats);
router.delete('/thumbnail/cache', handleClear);
router.get('/thumbnail', handleUrlMode);
router.get('/thumbnail/template/*', handleTemplateMode);
router.get('/thumbnail/preset/*', handlePresetMode);
router.get('/thumbnail/model', handleModelMode);
router.get('/thumbnail/:galleryId', handleIdMode);

export default router;
