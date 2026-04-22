// DEPRECATED — remove after UI migration lands.
// Back-compat adapter for `/api/gallery/thumbnail?filename=&subfolder=&type=&w=`.
// Delegates to the legacy `videoThumbnail.service` (which writes under
// `.cache/video-thumbs/`) so pre-migration callers keep hitting the same
// cache path. The unified service (`/api/thumbnail/:id`) is the migration
// target for new call sites; once the UI is fully switched over this file
// and `videoThumbnail.service.ts` can both be deleted.

import { Router, type Request, type Response } from 'express';
import { createReadStream } from 'fs';
import { sanitizeSegment, resolveViewPath } from '../lib/viewPath.js';
import {
  thumbnailForVideo, isVideoThumbError,
} from '../services/videoThumbnail.service.js';
import { logger } from '../lib/logger.js';

const router = Router();

const DEFAULT_WIDTH = 320;

function parseWidth(raw: unknown): number | { error: string } {
  if (raw == null || raw === '') return DEFAULT_WIDTH;
  if (typeof raw !== 'string') return { error: 'w must be an integer' };
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return { error: 'w must be an integer' };
  return n;
}

router.get(
  ['/gallery/thumbnail', '/launcher/gallery/thumbnail'],
  async (req: Request, res: Response) => {
    const rawFilename = req.query.filename;
    if (typeof rawFilename !== 'string' || rawFilename.length === 0) {
      res.status(400).json({ error: 'filename required' });
      return;
    }
    const filename = sanitizeSegment(rawFilename);
    const subfolder = sanitizeSegment(
      typeof req.query.subfolder === 'string' ? req.query.subfolder : undefined,
    );
    const type = sanitizeSegment(
      typeof req.query.type === 'string' ? req.query.type : undefined,
    );
    if (filename === null || subfolder === null || type === null) {
      res.status(400).json({ error: 'invalid path segment' });
      return;
    }

    const width = parseWidth(req.query.w);
    if (typeof width !== 'number') {
      res.status(400).json({ error: width.error });
      return;
    }

    const resolved = resolveViewPath(filename, subfolder || '', type || 'output');
    if (!resolved) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    try {
      const { filePath, contentType } = await thumbnailForVideo({
        absPath: resolved.absPath,
        width,
      });
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      createReadStream(filePath).pipe(res);
    } catch (err) {
      if (isVideoThumbError(err)) {
        if (err.code === 'INVALID_WIDTH') {
          res.status(400).json({ error: 'INVALID_WIDTH' });
          return;
        }
        if (err.code === 'FFMPEG_MISSING') {
          res.status(404).json({ error: 'FFMPEG_MISSING' });
          return;
        }
        logger.warn('gallery thumbnail: ffmpeg failed', {
          filename, detail: err.detail,
        });
        res.status(502).json({ error: 'FFMPEG_FAILED' });
        return;
      }
      logger.warn('gallery thumbnail: unexpected error', {
        filename,
        message: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: 'THUMBNAIL_FAILED' });
    }
  },
);

export default router;
