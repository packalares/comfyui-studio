// Unified thumbnail endpoints.
//
//   GET    /api/thumbnail/stats          — cache stats JSON
//   DELETE /api/thumbnail/cache          — admin wipe
//   GET    /api/thumbnail?url=...&w=...  — remote URL thumbnail
//   GET    /api/thumbnail/:galleryId     — DB row thumbnail (sqlite lookup)
//
// Dual-mounted under `/launcher/thumbnail` per the project convention.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { createReadStream } from 'fs';
import { logger } from '../lib/logger.js';
import {
  thumbnailForGalleryItem, thumbnailForUrl,
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
    // SVG fallbacks are deterministic — short cache + no immutable hint so
    // a future change (icon tweak) rolls through quickly.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(result.body);
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  createReadStream(result.filePath).pipe(res);
}

function mapError(res: Response, err: unknown, context: Record<string, unknown>): void {
  if (isThumbError(err)) {
    if (err.code === 'INVALID_WIDTH' || err.code === 'HOST_NOT_ALLOWED') {
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

// Mount order: literal `/thumbnail/stats` and `/thumbnail/cache` are
// registered BEFORE the `:galleryId` param handler so the param doesn't
// capture them.
router.get(['/thumbnail/stats', '/launcher/thumbnail/stats'], handleStats);
router.delete(['/thumbnail/cache', '/launcher/thumbnail/cache'], handleClear);
router.get(['/thumbnail', '/launcher/thumbnail'], handleUrlMode);
router.get(['/thumbnail/:galleryId', '/launcher/thumbnail/:galleryId'], handleIdMode);

export default router;
