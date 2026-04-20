// Image upload proxy. Parses multipart on our side (bounded size) and re-POSTs
// as multipart to ComfyUI's /api/upload/image so it lands in the right folder.
//
// Rejection paths (hardening):
//   - mimetype outside image/audio/video
//   - filename extension on the executable/script deny-list
//   - size over env.UPLOAD_MAX_BYTES
//   - missing file

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';

const COMFYUI_URL = env.COMFYUI_URL;

// 60 uploads/min per IP. multer also enforces per-request byte caps.
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 60 });

// Extensions we reject even if the claimed mimetype is safe. SVG is included
// because it can carry <script> and re-render as an image. .html/.js/.bat/.sh
// should never arrive via an "image upload" in any case.
const DENY_EXTS = new Set(['.exe', '.bat', '.sh', '.js', '.html', '.svg']);

const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_BYTES },
});

const router = Router();

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i).toLowerCase();
}

// Exported for tests. Accepts a narrow shape so test code doesn't have to
// fabricate a full Express.Multer.File.
export function uploadRejectionReason(
  file: { mimetype: string; originalname: string },
): string | null {
  if (!ALLOWED_MIME_PREFIXES.some(p => file.mimetype.startsWith(p))) {
    return 'mimetype not allowed';
  }
  if (DENY_EXTS.has(extOf(file.originalname))) {
    return 'extension on deny-list';
  }
  return null;
}

async function forwardToComfy(file: Express.Multer.File): ReturnType<typeof fetch> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype });
  form.append('image', blob, file.originalname);
  return fetch(`${COMFYUI_URL}/api/upload/image`, { method: 'POST', body: form });
}

router.post('/upload', uploadLimiter, upload.single('image'), async (req: Request, res: Response) => {
  try {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: 'upload.rejected', detail: 'no file provided' });
      return;
    }
    const reason = uploadRejectionReason(file);
    if (reason) {
      res.status(400).json({ error: 'upload.rejected', detail: reason });
      return;
    }
    const upstream = await forwardToComfy(file);
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.status(upstream.status).json({ error: 'ComfyUI rejected upload', detail });
      return;
    }
    res.json(await upstream.json());
  } catch (err) {
    sendError(res, err, 500, 'Upload failed');
  }
});

export default router;
