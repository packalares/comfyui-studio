// Image upload proxy. Parses multipart on our side (bounded size) and
// re-POSTs it as multipart to ComfyUI's /api/upload/image.
//
// Wave-Q: switched from `multer.memoryStorage()` to disk-backed spool so
// large (video) uploads don't buffer the entire payload in RAM. Files are
// written to `paths.uploadsTmpDir` under a random name, streamed to
// ComfyUI, and unlinked in the handler's `finally` block — success, error,
// or thrown, the cleanup always runs. A startup sweep in
// `sweepStaleUploads()` catches the rare orphan from a pod crash during
// an in-flight upload.
//
// Rejection paths (hardening):
//   - mimetype outside image/audio/video
//   - filename extension on the executable/script deny-list
//   - size over env.UPLOAD_MAX_BYTES (surfaced as structured 413)
//   - missing file

import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../config/env.js';
import { paths } from '../config/paths.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';
import { logger } from '../lib/logger.js';

const COMFYUI_URL = env.COMFYUI_URL;

// 60 uploads/min per IP. multer also enforces per-request byte caps.
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 60 });

// Extensions we reject even if the claimed mimetype is safe. SVG is included
// because it can carry <script> and re-render as an image. .html/.js/.bat/.sh
// should never arrive via an "image upload" in any case.
const DENY_EXTS = new Set(['.exe', '.bat', '.sh', '.js', '.html', '.svg']);

const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/'];

// Ensure the tmp dir exists at module load — multer will otherwise error on
// the first upload. `recursive: true` makes this idempotent.
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

/**
 * Strip any directory segments the client supplied. `file.originalname` is
 * attacker-controlled; even though ComfyUI's own upload endpoint sanitizes
 * downstream, we defense-in-depth at the boundary so traversal payloads
 * (`../../evil.png`) can't leak into anything that echoes the name back.
 */
function safeFilename(originalname: string): string {
  return path.basename(originalname);
}

// Exported for tests. Accepts a narrow shape so test code doesn't have to
// fabricate a full Express.Multer.File.
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
  // Stream the on-disk spool straight to ComfyUI, no in-memory copy.
  // `fs.openAsBlob` (Node 19.8+) backs the Blob with the file on disk, so
  // undici's multipart encoder pulls bytes lazily as the socket drains.
  // The prior `readFile(...) + new Blob([...])` dance silently defeated the
  // whole point of diskStorage for large (video) uploads.
  const blob = await fs.openAsBlob(file.path, { type: file.mimetype });
  const form = new FormData();
  form.append('image', blob, safeFilename(file.originalname));
  return fetch(`${COMFYUI_URL}/api/upload/image`, { method: 'POST', body: form });
}

/**
 * Multer error handler: multer throws `LIMIT_FILE_SIZE` when the upload
 * exceeds `fileSize`. Surface this as a structured 413 so the frontend
 * can render a specific "File too large (max X MB)" toast instead of a
 * generic "Upload failed".
 */
function handleMulterError(
  err: unknown, _req: Request, res: Response, next: NextFunction,
): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({
      error: 'File too large',
      maxBytes: env.UPLOAD_MAX_BYTES,
    });
    return;
  }
  next(err);
}

router.post(
  '/upload',
  uploadLimiter,
  (req, res, next) => upload.single('image')(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  }),
  async (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    try {
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
    } finally {
      if (file?.path) {
        fs.unlink(file.path, () => { /* fire-and-forget; sweep handles orphans */ });
      }
    }
  },
);

/**
 * Startup sweep of the uploads tmp dir — deletes files older than one hour.
 * Catches the rare orphan when a pod crash interrupted an in-flight upload
 * so our `finally` never ran. Safe to call at any time; it only touches
 * files under `paths.uploadsTmpDir` that are older than the cutoff.
 */
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
      } catch { /* file vanished between readdir and stat — ignore */ }
    }
  } catch (err) {
    logger.warn('uploads sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export default router;
