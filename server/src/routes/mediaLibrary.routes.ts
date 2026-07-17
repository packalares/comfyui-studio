// Media library: list / upload / delete entries in ComfyUI's `input/` dir.
//
// Used by the Studio Easy-mode media-pick modal. New uploads land in
// kind-specific subfolders (`input/images/`, `input/audio/`, `input/videos/`)
// so the dir stays tidy as users accumulate references. ComfyUI's LoadImage
// / LoadAudio nodes scan input/ recursively, so a file at `input/images/x.png`
// shows in their combo as `images/x.png` and loads correctly on submit.

import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../config/env.js';
import { paths } from '../config/paths.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { authMiddleware } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { ValidationError, InternalError, HttpError } from '../lib/errors.js';
import { uploadRejectionReason } from './upload.routes.js';
import {
  listLibrary, deleteLibraryItem, subfolderForKind, extsFor,
  resolveLibraryPath, type MediaKind, type Scope,
} from '../services/mediaLibrary.js';

const router = Router();

const ALLOWED_KINDS: ReadonlySet<MediaKind> = new Set(['image', 'audio', 'video']);
const ALLOWED_SCOPES: ReadonlySet<Scope> = new Set(['input', 'output']);

function parseKind(raw: unknown): MediaKind {
  if (typeof raw !== 'string' || !ALLOWED_KINDS.has(raw as MediaKind)) {
    throw new ValidationError('kind must be image, audio, or video');
  }
  return raw as MediaKind;
}

/** Optional `scope` query param; default 'input' (back-compat). 'output'
 *  browses ComfyUI's output/ dir read-only. */
function parseScope(raw: unknown): Scope {
  if (raw === undefined || raw === '') return 'input';
  if (typeof raw !== 'string' || !ALLOWED_SCOPES.has(raw as Scope)) {
    throw new ValidationError('scope must be input or output');
  }
  return raw as Scope;
}

const uploadLimiter = rateLimit('upload');

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
  fileFilter: (_req, file, cb) => {
    const reason = uploadRejectionReason(file);
    if (reason) { cb(new ValidationError(reason)); return; }
    cb(null, true);
  },
});

function handleMulterError(
  err: unknown, _req: Request, _res: Response, next: NextFunction,
): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new HttpError('payload_too_large', 'File too large', { maxBytes: env.UPLOAD_MAX_BYTES }));
    return;
  }
  next(err);
}

// Disambiguate filename inside the destination subfolder by appending
// `-2`, `-3`, ... before the extension. Bounded — anything past the cap
// falls back to a timestamp suffix.
function uniqueName(destDir: string, original: string): string {
  const base = path.basename(original);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  if (!fs.existsSync(path.join(destDir, base))) return base;
  for (let i = 2; i <= 200; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(path.join(destDir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

// GET /api/media-library?kind=image|audio|video&scope=input|output
router.get('/media-library', authMiddleware({ required: true, scopes: ['gallery:read'] as const }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const kind = parseKind(req.query.kind);
      const scope = parseScope(req.query.scope);
      res.json({ data: { items: listLibrary(kind, scope) } });
    } catch (err) {
      next(err instanceof Error ? err : new InternalError('media-library list failed'));
    }
  },
);

// POST /api/media-library?kind=image|audio|video  (multipart "file")
router.post(
  '/media-library',
  uploadLimiter,
  authMiddleware({ required: true, scopes: ['gallery:write'] as const }),
  (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  }),
  (req: Request, res: Response, next: NextFunction) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    try {
      const kind = parseKind(req.query.kind);
      if (!file) throw new ValidationError('No file provided');
      // Refuse files whose extension doesn't match the requested kind so
      // callers can't quietly drop an .mp3 into images/.
      const ext = path.extname(file.originalname).toLowerCase();
      if (!extsFor(kind).has(ext)) {
        throw new ValidationError(`extension ${ext || '(none)'} not allowed for kind ${kind}`);
      }
      const subfolder = subfolderForKind(kind);
      const destDir = path.join(env.COMFYUI_PATH, 'input', subfolder);
      fs.mkdirSync(destDir, { recursive: true });
      const safeName = uniqueName(destDir, path.basename(file.originalname));
      const destAbs = path.join(destDir, safeName);
      fs.renameSync(file.path, destAbs);
      const stat = fs.statSync(destAbs);
      res.json({
        data: {
          filename: safeName,
          subfolder,
          ref: `${subfolder}/${safeName}`,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          kind,
        },
      });
    } catch (err) {
      if (file?.path) {
        // Cleanup tmp on error — rename above may have already consumed it.
        fs.unlink(file.path, () => { /* fire-and-forget */ });
      }
      if (err instanceof Error) next(err);
      else { logger.error('media-library upload failed', { err: String(err) }); next(new InternalError('upload failed')); }
    }
  },
);

// DELETE /api/media-library?filename=...&subfolder=...
router.delete('/media-library', authMiddleware({ required: true, scopes: ['gallery:write'] as const }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      const subfolder = typeof req.query.subfolder === 'string' ? req.query.subfolder : '';
      if (!filename) throw new ValidationError('filename required');
      const abs = resolveLibraryPath(subfolder, filename);
      if (!abs) throw new ValidationError('invalid path');
      const ok = deleteLibraryItem(subfolder, filename);
      res.json({ data: { ok } });
    } catch (err) {
      next(err instanceof Error ? err : new InternalError('media-library delete failed'));
    }
  },
);

export default router;
