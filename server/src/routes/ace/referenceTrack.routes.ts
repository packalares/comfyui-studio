// ACE-Step reference-track routes. Ported from ace-step-ui's
// `server/src/routes/referenceTrack.ts` (Postgres-style, multi-user CRUD
// over a `reference_tracks` table + a generic-`whisper`-binary transcribe
// endpoint).
//
// SINGLE-USER: no `user_id` scoping/ownership checks (see
// `lib/db/migrations/0006_ace_training.ts`'s header). Storage reuses Wave
// 2a's `services/ace/storage.ts` 'reference' audio kind — the same
// mechanism `routes/ace/generate.routes.ts` uses for cover/audio2audio
// source uploads — rather than a separate storage path, since these are the
// same kind of asset (user-uploaded reference audio) with an extra DB row
// for metadata (duration, tags, transcribed lyrics). Playback is served
// through that module's existing `GET /ace/audio/:kind/:key` route.
//
// Transcription is wrapped in `submitGpuJob('ace-whisper', ...)` (tenant
// `oneshot`) and reuses `services/ace/audioSeparator.ts`'s
// `transcribeSingleFile` (faster-whisper) instead of ace-step-ui's
// `findWhisperExecutable`/generic-`whisper`-binary approach — one Whisper
// install to maintain instead of two.

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import path from 'path';
import { defineRoute } from '../../lib/defineRoute.js';
import { HttpError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { authMiddleware } from '../../middleware/auth.js';
import { submitGpuJob } from '../../services/gpu/scheduler.js';
import * as storage from '../../services/ace/storage.js';
import * as aceTrainingRepo from '../../lib/db/aceTraining.repo.js';
import { transcribeSingleFile } from '../../services/ace/audioSeparator.js';
import {
  ListReferenceTracksResponseSchema,
  UploadReferenceTrackResponseSchema,
  ReferenceTrackParamsSchema,
  UpdateReferenceTrackBodySchema,
  UpdateReferenceTrackResponseSchema,
  TranscribeReferenceTrackResponseSchema,
  DeleteReferenceTrackResponseSchema,
} from '../../contracts/ace/referenceTrack.contract.js';

const router = Router();

function toWireTrack(row: aceTrainingRepo.ReferenceTrackRow) {
  return {
    id: row.id,
    filename: row.filename,
    audioUrl: storage.audioPublicUrl('reference', row.storageKey),
    duration: row.duration,
    fileSizeBytes: row.fileSizeBytes,
    lyrics: row.lyrics,
    tags: row.tags,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// GET /ace/reference-tracks
// ---------------------------------------------------------------------------

const listRoute = defineRoute({
  method: 'GET',
  path: '/ace/reference-tracks',
  response: ListReferenceTracksResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'List uploaded reference/source audio tracks',
}, ({ ok }) => {
  const tracks = aceTrainingRepo.listReferenceTracks().map(toWireTrack);
  return ok({ tracks });
});

// ---------------------------------------------------------------------------
// POST /ace/reference-tracks — multipart upload; spec registered via
// `defineRoute` for OpenAPI/audit purposes only (multer must run before body
// handling — same pattern as `routes/ace/generate.routes.ts`'s upload-audio).
// ---------------------------------------------------------------------------

const MAX_UPLOAD_AUDIO_BYTES = 50 * 1024 * 1024;
const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.webm', '.opus']);
const ALLOWED_AUDIO_MIME_PREFIXES = ['audio/', 'video/mp4'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_AUDIO_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = ALLOWED_AUDIO_MIME_PREFIXES.some((p) => file.mimetype.startsWith(p));
    if (mimeOk || ALLOWED_AUDIO_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new ValidationError(`Invalid file type: ${file.mimetype} (${file.originalname})`));
    }
  },
});

const uploadSpec = {
  method: 'POST' as const,
  path: '/ace/reference-tracks',
  response: UploadReferenceTrackResponseSchema,
  auth: { required: true, scopes: ['generate:write'] as const },
  tags: ['ace'],
  summary: 'Upload a reference/source audio track',
};

// Registered for OpenAPI/audit visibility only — never actually invoked.
defineRoute(uploadSpec, async () => ({ data: { track: toWireTrack({
  id: '', filename: '', storageKey: '', duration: null, fileSizeBytes: null, lyrics: null, tags: [], createdAt: 0,
}) } }));

function handleUploadError(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new HttpError('payload_too_large', 'File too large', { maxBytes: MAX_UPLOAD_AUDIO_BYTES }));
    return;
  }
  next(err);
}

router.post(
  '/ace/reference-tracks',
  authMiddleware(uploadSpec.auth),
  (req, res, next) => upload.single('audio')(req, res, (err) => {
    if (err) { handleUploadError(err, req, res, next); return; }
    next();
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) throw new ValidationError('Audio file is required');
      const ext = path.extname(file.originalname || '') || '.audio';
      const stored = await storage.saveReferenceAudio(file.buffer, ext);
      const row = aceTrainingRepo.insertReferenceTrack({
        id: randomUUID(),
        filename: file.originalname || stored.key,
        storageKey: stored.key,
        fileSizeBytes: file.size,
      });
      res.status(201).json({ data: { track: toWireTrack(row) } });
    } catch (err) {
      if (err instanceof Error) {
        next(err);
      } else {
        logger.error('ace reference-track upload failed', { message: String(err) });
        next(new HttpError('internal_error', 'Upload failed'));
      }
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /ace/reference-tracks/:id
// ---------------------------------------------------------------------------

const updateRoute = defineRoute({
  method: 'PATCH',
  path: '/ace/reference-tracks/:id',
  params: ReferenceTrackParamsSchema,
  body: UpdateReferenceTrackBodySchema,
  response: UpdateReferenceTrackResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Update a reference track\'s duration/tags',
}, ({ params, body, ok }) => {
  const existing = aceTrainingRepo.getReferenceTrack(params.id);
  if (!existing) throw new NotFoundError('Track not found');
  const updated = aceTrainingRepo.updateReferenceTrack(params.id, {
    duration: body.duration,
    tags: body.tags,
  });
  return ok({ track: toWireTrack(updated!) });
});

// ---------------------------------------------------------------------------
// POST /ace/reference-tracks/:id/transcribe
// ---------------------------------------------------------------------------

const transcribeRoute = defineRoute({
  method: 'POST',
  path: '/ace/reference-tracks/:id/transcribe',
  params: ReferenceTrackParamsSchema,
  response: TranscribeReferenceTrackResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Transcribe a reference track\'s lyrics via faster-whisper',
}, async ({ params, ok }) => {
  const track = aceTrainingRepo.getReferenceTrack(params.id);
  if (!track) throw new NotFoundError('Track not found');

  const absPath = storage.resolveAudioAbsPath('reference', track.storageKey);
  const lyrics = await submitGpuJob('ace-whisper', async (release) => {
    try {
      return await transcribeSingleFile(absPath);
    } finally {
      release();
    }
  });

  if (lyrics) aceTrainingRepo.updateReferenceTrack(params.id, { lyrics });
  return ok({ lyrics: lyrics || '' });
});

// ---------------------------------------------------------------------------
// DELETE /ace/reference-tracks/:id
// ---------------------------------------------------------------------------

const deleteRoute = defineRoute({
  method: 'DELETE',
  path: '/ace/reference-tracks/:id',
  params: ReferenceTrackParamsSchema,
  response: DeleteReferenceTrackResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Delete a reference track',
}, async ({ params, ok }) => {
  const deleted = aceTrainingRepo.deleteReferenceTrack(params.id);
  if (!deleted) throw new NotFoundError('Track not found');
  await storage.deleteAudio('reference', deleted.storageKey).catch((err) => {
    logger.warn('ace reference-track file delete failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return ok({ success: true });
});

[listRoute, updateRoute, transcribeRoute, deleteRoute].forEach((r) => r.register(router));

export default router;
