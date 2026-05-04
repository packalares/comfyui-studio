// Unified thumbnail endpoints.
//
//   GET    /api/thumbnail/stats             — cache stats JSON
//   DELETE /api/thumbnail/cache             — admin wipe
//   GET    /api/thumbnail?url=...&w=...     — remote URL thumbnail
//   GET    /api/thumbnail/template/<path>   — ComfyUI templates/<path>
//   GET    /api/thumbnail/:galleryId        — DB row thumbnail (sqlite lookup)

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { createReadStream } from 'fs';
import { logger } from '../lib/logger.js';
import {
  thumbnailForGalleryItem, thumbnailForTemplateAsset, thumbnailForUrl,
} from '../services/thumbnail/service.js';
import { collectStats, clearCache, scheduleSweeps } from '../services/thumbnail/sweep.js';
import { isThumbError, type ThumbResult } from '../services/thumbnail/types.js';

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

function mapError(res: Response, err: unknown, context: Record<string, unknown>): void {
  if (isThumbError(err)) {
    if (
      err.code === 'INVALID_WIDTH'
      || err.code === 'HOST_NOT_ALLOWED'
      || err.code === 'INVALID_PATH'
      || err.code === 'INVALID_URL'
    ) {
      res.status(400).json({ error: err.code });
      return;
    }
    // DB_LOOKUP_FAILED maps to 404 (not 502) so tile grids that pass an id
    // the DB can't find degrade gracefully instead of painting an error.
    if (
      err.code === 'NOT_FOUND'
      || err.code === 'UNSUPPORTED_EXTENSION'
      || err.code === 'FFMPEG_MISSING'
      || err.code === 'DB_LOOKUP_FAILED'
    ) {
      if (err.code === 'DB_LOOKUP_FAILED') {
        logger.warn('thumbnail: db lookup failed', { ...context, detail: err.detail });
      }
      res.status(404).json({ error: err.code });
      return;
    }
    logger.warn('thumbnail: pipeline error', { ...context, code: err.code, detail: err.detail });
    res.status(502).json({ error: err.code });
    return;
  }
  logger.warn('thumbnail: unexpected error', {
    ...context,
    message: err instanceof Error ? err.message : String(err),
  });
  res.status(502).json({ error: 'THUMBNAIL_FAILED' });
}

const handleStats: RequestHandler = async (_req: Request, res: Response) => {
  try {
    const stats = await collectStats();
    res.json(stats);
  } catch (err) {
    mapError(res, err, { op: 'stats' });
  }
};

const handleClear: RequestHandler = async (_req: Request, res: Response) => {
  try {
    const { deleted } = await clearCache();
    res.json({ deleted });
  } catch (err) {
    mapError(res, err, { op: 'clear' });
  }
};

const handleUrlMode: RequestHandler = async (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) { res.status(400).json({ error: 'url required' }); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { res.status(400).json({ error: width.error }); return; }
  try {
    const result = await thumbnailForUrl({ url, width });
    sendThumb(res, result);
  } catch (err) {
    mapError(res, err, { url });
  }
};

const handleIdMode: RequestHandler = async (req: Request, res: Response) => {
  const rawId = req.params.galleryId;
  const galleryId = typeof rawId === 'string' ? rawId : '';
  if (!galleryId) { res.status(400).json({ error: 'galleryId required' }); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { res.status(400).json({ error: width.error }); return; }
  try {
    const result = await thumbnailForGalleryItem({ galleryId, width });
    sendThumb(res, result);
  } catch (err) {
    mapError(res, err, { galleryId });
  }
};

const handleTemplateMode: RequestHandler = async (req: Request, res: Response) => {
  // `*` glob captures the rest of the path including nested segments — the
  // matched value lives at `req.params[0]` per Express 4 wildcard semantics.
  const rawPath = (req.params as Record<string, unknown>)[0];
  const assetPath = typeof rawPath === 'string' ? rawPath : '';
  if (!assetPath) { res.status(400).json({ error: 'assetPath required' }); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { res.status(400).json({ error: width.error }); return; }
  try {
    const result = await thumbnailForTemplateAsset({ assetPath, width });
    sendThumb(res, result);
  } catch (err) {
    mapError(res, err, { assetPath });
  }
};

// Mount order: literal `/thumbnail/stats`, `/thumbnail/cache`, and the
// `/thumbnail/template/*` glob are registered BEFORE the `:galleryId`
// param handler so the param doesn't swallow them.
router.get('/thumbnail/stats', handleStats);
router.delete('/thumbnail/cache', handleClear);
router.get('/thumbnail', handleUrlMode);
router.get('/thumbnail/template/*', handleTemplateMode);
router.get('/thumbnail/:galleryId', handleIdMode);

export default router;
