// Serves chat attachment files written by `extractAndPersistAttachments`.
//
// GET /api/chat/attachments/:filename
//   Path traversal guard: rejects filenames with `..`, `/`, or `\`;
//   additionally verifies the resolved path is inside attachmentDir().

import path from 'path';
import { Router, type Request, type Response } from 'express';
import { attachmentDir } from '../services/chat/attachments.js';

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  bin: 'application/octet-stream',
};

function mimeFromExt(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

const router = Router();

router.get('/chat/attachments/:filename', (req: Request, res: Response) => {
  const rawParam = req.params['filename'];
  const raw = typeof rawParam === 'string' ? rawParam : '';

  // Reject obviously malicious filenames before any path resolution.
  if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    res.status(400).json({ error: 'invalid filename' });
    return;
  }

  // Canonicalize: strip directory components (belt-and-suspenders).
  const filename = path.basename(raw);
  if (!filename || filename !== raw) {
    res.status(400).json({ error: 'invalid filename' });
    return;
  }

  const dir = attachmentDir();
  const resolved = path.resolve(dir, filename);

  // Verify resolved path is strictly inside the attachment directory.
  const rel = path.relative(dir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.status(400).json({ error: 'invalid filename' });
    return;
  }

  const ext = filename.includes('.') ? filename.split('.').pop()! : 'bin';
  const contentType = mimeFromExt(ext);

  res.setHeader('Content-Type', contentType);
  res.sendFile(filename, { root: dir }, (err) => {
    if (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: 'not found' });
      }
      // If headers already sent, Express handles it.
    }
  });
});

export default router;
