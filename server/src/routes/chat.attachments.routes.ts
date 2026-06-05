// Serves chat attachment files. The URL slug is `<id>.<ext>` where `<id>`
// is the chat_attachments primary key. We look up the row to verify the
// attachment exists, then sendFile from disk.
//
// GET /api/chat/attachments/:slug
//   Path traversal guard: rejects slugs with `..`, `/`, or `\`.
//   Slug must match `<base64url>.<ext>` shape. 404 when row missing.

import path from 'path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { attachmentDir } from '../services/chat/attachments.js';
import { getAttachment } from '../lib/db/chat.repo.js';
import { ValidationError, NotFoundError, InternalError } from '../lib/errors.js';

const SLUG_RX = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$/;

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  bin: 'application/octet-stream',
};

function mimeFromExt(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

const router = Router();

router.get('/chat/attachments/:slug', (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawParam = req.params['slug'];
    const raw = typeof rawParam === 'string' ? rawParam : '';

    // Reject obviously malicious slugs.
    if (raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
      throw new ValidationError('invalid slug');
    }

    const m = SLUG_RX.exec(raw);
    if (!m) throw new ValidationError('invalid slug');
    const id = m[1];
    const ext = m[2];

    const row = getAttachment(id);
    if (!row || row.ext !== ext) throw new NotFoundError('not found');

    const dir = attachmentDir();
    const filename = `${row.id}.${row.ext}`;
    const resolved = path.resolve(dir, filename);
    const rel = path.relative(dir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ValidationError('invalid path');
    }

    res.setHeader('Content-Type', row.mime_type || mimeFromExt(ext));
    res.sendFile(filename, { root: dir }, (err) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') next(new NotFoundError('not found'));
        else next(err);
      }
    });
  } catch (err) {
    next(err instanceof Error ? err : new InternalError('Attachment fetch failed'));
  }
});

export default router;
