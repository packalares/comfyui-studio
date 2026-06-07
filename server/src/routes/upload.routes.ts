// Image upload proxy. Parses multipart on our side (bounded size) and
// re-POSTs it as multipart to ComfyUI's /api/upload/image.
//
// defineRoute cannot wrap this route because multer's disk-storage middleware
// must run before our handler and populates `req.file` outside the normal
// body-parse path. We register the route manually but write all responses
// in the canonical `{ data }` envelope so the UI client's `apiCall` path works.
//
// NOTE(wave4): ComfyUI's upload response shape (`{ name, subfolder, type }`)
// is preserved verbatim inside `data`. Wave 4 should define a strict schema
// and validate it here instead of passing through the opaque blob.
//
// Rejection paths:
//   - mimetype outside image/audio/video
//   - extension on the executable/script deny-list
//   - size over env.UPLOAD_MAX_BYTES (structured 413)
//   - missing file

import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { paths } from '../config/paths.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';
import { defineRoute } from '../lib/defineRoute.js';
import { authMiddleware } from '../middleware/auth.js';
import { ValidationError, UpstreamUnavailableError, InternalError, HttpError } from '../lib/errors.js';

const COMFYUI_URL = env.COMFYUI_URL;

const uploadLimiter = rateLimit('upload');

const DENY_EXTS = new Set(['.exe', '.bat', '.sh', '.js', '.html', '.svg']);
const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];

fs.mkdirSync(paths.uploadsTmpDir, { recursive: true, mode: 0o700 });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, paths.uploadsTmpDir),
  filename: (_req, _file, cb) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    cb(null, id);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: env.UPLOAD_MAX_BYTES },
});

const router = Router();

function extOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i).toLowerCase();
}

function safeFilename(originalname: string): string {
  return path.basename(originalname);
}

export function uploadRejectionReason(
  file: { mimetype: string; originalname: string },
): string | null {
  if (!ALLOWED_MIME_PREFIXES.some(p => file.mimetype.startsWith(p))) {
    return 'mimetype not allowed';
  }
  if (DENY_EXTS.has(extOf(safeFilename(file.originalname)))) {
    return 'extension on deny-list';
  }
  return null;
}

async function forwardToComfy(file: Express.Multer.File): ReturnType<typeof fetch> {
  const blob = await fs.openAsBlob(file.path, { type: file.mimetype });
  const form = new FormData();
  form.append('image', blob, safeFilename(file.originalname));
  return fetch(`${COMFYUI_URL}/api/upload/image`, { method: 'POST', body: form });
}

function handleMulterError(
  err: unknown, _req: Request, _res: Response, next: NextFunction,
): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new HttpError('payload_too_large', 'File too large', { maxBytes: env.UPLOAD_MAX_BYTES }));
    return;
  }
  next(err);
}

// Auth spec published in the registry for OpenAPI / auth audit.
const uploadSpec = {
  method: 'POST' as const,
  path: '/upload',
  response: z.unknown(),
  auth: { required: true, scopes: ['gallery:write'] as const },
  tags: ['gallery'],
  summary: 'Upload an image/audio/video to ComfyUI',
};

// Register the spec in the route registry (for audit/OpenAPI) without mounting
// a handler — the handler is mounted manually below so multer runs first.
defineRoute(uploadSpec, async (_ctx) => {
  // This handler is never invoked; the real handler is mounted below.
  return { data: null };
});

router.post(
  '/upload',
  uploadLimiter,
  authMiddleware(uploadSpec.auth),
  (req, res, next) => upload.single('image')(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    try {
      if (!file) throw new ValidationError('No file provided');
      const reason = uploadRejectionReason(file);
      if (reason) throw new ValidationError(reason);
      const upstream = await forwardToComfy(file);
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        throw new UpstreamUnavailableError('ComfyUI rejected upload', detail);
      }
      // NOTE(wave4): upstream body is ComfyUI's opaque response. Wrap in
      // envelope but preserve the inner shape for back-compat. A future wave
      // should define CivitaiDownloadInfoSchema and validate here.
      const body = await upstream.json();
      res.json({ data: body });
    } catch (err) {
      if (err instanceof Error) {
        next(err);
      } else {
        logger.error('upload failed', { message: String(err) });
        next(new InternalError('Upload failed'));
      }
    } finally {
      if (file?.path) {
        fs.unlink(file.path, () => { /* fire-and-forget; sweep handles orphans */ });
      }
    }
  },
);

export function sweepStaleUploads(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  try {
    const entries = fs.readdirSync(paths.uploadsTmpDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const p = path.join(paths.uploadsTmpDir, e.name);
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* vanished between readdir and stat */ }
    }
  } catch (err) {
    logger.warn('uploads sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export default router;
