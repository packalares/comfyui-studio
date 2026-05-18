// Metadata-stripped download endpoint.
//
// GET /api/download?filename=X&subfolder=Y&type=output
//
// Streams a copy of the requested output file with ComfyUI metadata
// stripped (PNG tEXt chunks, FLAC Vorbis comments, EXIF UserComment,
// MP4 container atoms). Mirrors the query-param shape of /api/view so
// the client side can build the URL from the same GalleryItem fields.
//
// Only type=output is accepted. temp/input are refused — temp files are
// transient and input files are user-supplied originals we should not
// silently modify.

import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import { sanitizeSegment } from '../lib/viewPath.js';
import { safeResolve } from '../lib/fs.js';
import { paths } from '../config/paths.js';
import { logger } from '../lib/logger.js';
import { streamCleanDownload } from '../services/gallery/downloadStrip.js';

const router = Router();

router.get('/download', async (req: Request, res: Response) => {
  const rawFilename = req.query.filename;
  const rawSubfolder = req.query.subfolder;
  const rawType = req.query.type;

  if (typeof rawFilename !== 'string' || rawFilename.length === 0) {
    res.status(400).json({ error: 'filename required' });
    return;
  }

  const filename = sanitizeSegment(rawFilename);
  const subfolder = sanitizeSegment(
    typeof rawSubfolder === 'string' ? rawSubfolder : undefined,
  );
  const type = sanitizeSegment(
    typeof rawType === 'string' ? rawType : 'output',
  );

  if (filename === null || subfolder === null || type === null) {
    res.status(400).json({ error: 'invalid path segment' });
    return;
  }

  // Only output-type files are served. temp is not suitable for download
  // (files may disappear between request and read), and input files are
  // user originals that should not be re-encoded without explicit intent.
  const resolvedType = type || 'output';
  if (resolvedType !== 'output') {
    res.status(400).json({ error: 'only type=output is supported' });
    return;
  }

  const outputDir = paths.comfyOutputDir;
  if (!outputDir) {
    res.status(503).json({ error: 'output directory not configured' });
    return;
  }

  let absPath: string;
  try {
    absPath = safeResolve(outputDir, subfolder || '', filename);
  } catch {
    res.status(400).json({ error: 'invalid path segment' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  try {
    await streamCleanDownload(res, absPath, filename);
  } catch (err) {
    logger.warn('download: unexpected error', {
      filename,
      subfolder,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'download failed' });
    }
  }
});

export default router;
