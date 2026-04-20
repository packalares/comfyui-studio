// Proxy for ComfyUI-hosted media files (generated images, videos, audio).
//
// We preserve the upstream `Content-Type` so browsers render MP4/WAV/etc.
// correctly instead of downloading them. Filenames and subfolders are
// sanitized against path traversal before being handed to the upstream
// request builder.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';

const router = Router();

// Reject any filename/subfolder segment containing '..' or absolute-path markers.
// ComfyUI itself validates on its side, but failing closed here means a crafted
// request never reaches upstream and never logs a bogus path.
function sanitizePathSegment(value: string | undefined): string | null {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  if (value.includes('\0')) return null;
  if (value.includes('..')) return null;
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return null;
  return value;
}

// View proxy (image/video/audio from ComfyUI).
router.get('/view', async (req: Request, res: Response) => {
  try {
    const rawFilename = req.query.filename;
    const rawSubfolder = req.query.subfolder;
    const rawType = req.query.type;

    if (typeof rawFilename !== 'string' || rawFilename.length === 0) {
      res.status(400).json({ error: 'filename required' });
      return;
    }
    const filename = sanitizePathSegment(rawFilename);
    const subfolder = sanitizePathSegment(
      typeof rawSubfolder === 'string' ? rawSubfolder : undefined
    );
    const type = sanitizePathSegment(
      typeof rawType === 'string' ? rawType : undefined
    );
    if (filename === null || subfolder === null || type === null) {
      res.status(400).json({ error: 'invalid path segment' });
      return;
    }

    const upstream = await comfyui.proxyView(filename, subfolder || undefined);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch {
    res.status(502).json({ error: 'Cannot fetch from ComfyUI' });
  }
});

export default router;
