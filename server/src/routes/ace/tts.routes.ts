// ACE-Step voice-clone TTS (IndexTTS2) routes. Ported from ace-step-ui's
// `server/src/routes/tts.ts`.
//
// Unlike ace-step-ui (which served TTS output through its generic
// `/audio/tts/*` static mount backed by `server/public/`), comfy has no
// static file mount for generated media — song audio is streamed through a
// dedicated route (`routes/ace/generate.routes.ts`'s `GET
// /ace/audio/:kind/:key`); this file adds the equivalent `GET
// /ace/tts/audio/:key` for TTS clips.
//
// Inference is wrapped in `submitGpuJob('ace-tts', ...)` — tenant `oneshot`,
// which evicts ollama/comfy/ACE-Step before IndexTTS2's one-shot Python
// subprocess runs (see `services/gpu/residency.ts`).

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { defineRoute, registerSpecOnly } from '../../lib/defineRoute.js';
import { HttpError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { authMiddleware } from '../../middleware/auth.js';
import { safeResolve } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';
import { submitGpuJob } from '../../services/gpu/scheduler.js';
import { cloneVoiceTTS } from '../../services/ace/indextts2.js';
import * as ttsJobs from '../../services/ace/ttsJobs.js';
import {
  TtsCloneResponseSchema,
  TtsStatusParamsSchema,
  TtsStatusResponseSchema,
} from '../../contracts/ace/tts.contract.js';

const router = Router();

const TTS_AUDIO_URL_PREFIX = '/api/ace/tts/audio';

// ---------------------------------------------------------------------------
// POST /ace/tts/clone — multipart (refAudio + optional emoAudio), so —
// same as `routes/ace/generate.routes.ts`'s upload-audio — the spec is
// registered via `defineRoute` for OpenAPI/audit purposes only and the real
// handler is mounted manually below multer.
// ---------------------------------------------------------------------------

const MAX_UPLOAD_AUDIO_BYTES = 25 * 1024 * 1024;
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

const cpUpload = upload.fields([
  { name: 'refAudio', maxCount: 1 },
  { name: 'emoAudio', maxCount: 1 },
]);

function pickFile(
  files: { [field: string]: Express.Multer.File[] } | undefined,
  field: string,
): Express.Multer.File | undefined {
  return files?.[field]?.[0];
}

function extForFile(file: Express.Multer.File): string {
  const fromName = path.extname(file.originalname || '').toLowerCase();
  if (fromName) return fromName;
  switch (file.mimetype) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav';
    case 'audio/flac':
    case 'audio/x-flac':
      return '.flac';
    case 'audio/ogg':
      return '.ogg';
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/aac':
      return '.m4a';
    case 'audio/webm':
      return '.webm';
    default:
      return '.audio';
  }
}

const cloneSpec = {
  method: 'POST' as const,
  path: '/ace/tts/clone',
  response: TtsCloneResponseSchema,
  auth: { required: true, scopes: ['generate:write'] as const },
  tags: ['ace'],
  summary: 'Clone a voice from a reference clip and synthesize speech (IndexTTS2)',
};

// Registered for OpenAPI/audit visibility only — never actually invoked.
defineRoute(cloneSpec, async () => ({ data: { jobId: '' } }));

function handleUploadError(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new HttpError('payload_too_large', 'File too large', { maxBytes: MAX_UPLOAD_AUDIO_BYTES }));
    return;
  }
  next(err);
}

router.post(
  '/ace/tts/clone',
  authMiddleware(cloneSpec.auth),
  (req, res, next) => cpUpload(req, res, (err) => {
    if (err) { handleUploadError(err, req, res, next); return; }
    next();
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = (req as Request & { files?: { [field: string]: Express.Multer.File[] } }).files;
      const refFile = pickFile(files, 'refAudio');
      if (!refFile) throw new ValidationError('refAudio file is required');
      const text = String((req.body as Record<string, unknown>)?.text ?? '').trim();
      if (!text) throw new ValidationError('text is required');

      const body = req.body as Record<string, unknown>;
      const emoAlpha = body.emoAlpha !== undefined ? Number(body.emoAlpha) : undefined;
      const emoText = body.emoText ? String(body.emoText) : undefined;
      let emoVector: number[] | undefined;
      if (body.emoVector) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(body.emoVector));
        } catch {
          throw new ValidationError('emoVector must be valid JSON');
        }
        if (!Array.isArray(parsed) || parsed.length !== 8 || !parsed.every((n) => typeof n === 'number')) {
          throw new ValidationError('emoVector must be a JSON array of 8 numbers');
        }
        emoVector = parsed;
      }
      const fp16 = body.fp16 === undefined ? true : String(body.fp16) === 'true';
      const seed = body.seed !== undefined && body.seed !== '' ? Number(body.seed) : undefined;
      const intervalSilence = body.intervalSilence !== undefined && body.intervalSilence !== ''
        ? Number(body.intervalSilence)
        : undefined;

      await fs.promises.mkdir(paths.uploadsTmpDir, { recursive: true });
      await fs.promises.mkdir(paths.aceTtsOutputDir, { recursive: true });

      const job = ttsJobs.createJob();
      const refPath = safeResolve(paths.uploadsTmpDir, `${job.id}-ref${extForFile(refFile)}`);
      await fs.promises.writeFile(refPath, refFile.buffer);

      let emoPath: string | undefined;
      const emoFile = pickFile(files, 'emoAudio');
      if (emoFile) {
        emoPath = safeResolve(paths.uploadsTmpDir, `${job.id}-emo${extForFile(emoFile)}`);
        await fs.promises.writeFile(emoPath, emoFile.buffer);
      }

      const outputPath = safeResolve(paths.aceTtsOutputDir, `${job.id}.wav`);
      const audioUrl = `${TTS_AUDIO_URL_PREFIX}/${job.id}.wav`;

      // Respond immediately; run inference in the background under the GPU
      // scheduler's 'ace-tts' tenant (oneshot).
      res.json({ data: { jobId: job.id } });

      ttsJobs.updateJob(job.id, { status: 'running', progress: 0.05, appendLog: 'queued' });

      void submitGpuJob('ace-tts', async (release) => {
        try {
          const result = await cloneVoiceTTS({
            refAudioPath: refPath,
            text,
            outputPath,
            emoAudioPath: emoPath,
            emoAlpha,
            emoText,
            emoVector,
            fp16,
            intervalSilence,
            seed,
            onProgress: (line) => {
              const current = ttsJobs.getJob(job.id);
              let progress = current?.progress ?? 0.05;
              if (line.includes('phase=loading')) progress = 0.15;
              else if (line.includes('phase=snapshot_download')) progress = 0.2;
              else if (line.includes('phase=generating')) progress = 0.5;
              else if (line.includes('phase=done')) progress = 0.95;
              ttsJobs.updateJob(job.id, { appendLog: line, progress });
            },
          });
          ttsJobs.updateJob(job.id, {
            status: 'completed',
            progress: 1,
            result: { audioUrl, durationSeconds: result.durationSeconds },
            appendLog: `done in ${result.totalElapsedMs}ms (${result.durationSeconds.toFixed(2)}s audio)`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('[ace-tts] clone failed', { message });
          ttsJobs.updateJob(job.id, {
            status: 'failed',
            error: message,
            appendLog: `error: ${message}`,
          });
        } finally {
          release();
          for (const p of [refPath, emoPath]) {
            if (!p) continue;
            try { await fs.promises.unlink(p); } catch { /* best-effort */ }
          }
        }
      }).catch(() => { /* terminal state already recorded on the job row above */ });
    } catch (err) {
      if (err instanceof Error) {
        next(err);
      } else {
        logger.error('ace tts clone failed', { message: String(err) });
        next(new HttpError('internal_error', 'TTS clone failed'));
      }
    }
  },
);

// ---------------------------------------------------------------------------
// GET /ace/tts/status/:jobId
// ---------------------------------------------------------------------------

const statusRoute = defineRoute({
  method: 'GET',
  path: '/ace/tts/status/:jobId',
  params: TtsStatusParamsSchema,
  response: TtsStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Poll a voice-clone TTS job',
}, ({ params, ok }) => {
  const job = ttsJobs.getJob(params.jobId);
  if (!job) throw new NotFoundError('Job not found');
  return ok(ttsJobs.toStatusView(job));
});

// ---------------------------------------------------------------------------
// GET /ace/tts/audio/:key — stream a generated TTS clip. No `defineRoute`
// wrapper (an `<audio src>` tag can't attach a Bearer token) — mirrors
// `routes/ace/generate.routes.ts`'s `GET /ace/audio/:kind/:key`.
// ---------------------------------------------------------------------------

registerSpecOnly({
  method: 'GET',
  path: '/ace/tts/audio/:key',
  response: z.unknown(), // this route streams a binary body, not JSON
  auth: { required: false },
  tags: ['ace'],
  summary: 'Stream a generated voice-clone TTS clip',
});

router.get('/ace/tts/audio/:key', (req: Request, res: Response) => {
  const { key } = req.params;
  if (typeof key !== 'string' || !/^[a-zA-Z0-9-]+\.wav$/.test(key)) {
    res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid audio key' } });
    return;
  }
  let absPath: string;
  try {
    absPath = safeResolve(paths.aceTtsOutputDir, key);
  } catch {
    res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid audio key' } });
    return;
  }
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.status(404).json({ error: { code: 'not_found', message: 'Audio not found' } });
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(absPath).pipe(res);
  });
});

[statusRoute].forEach((r) => r.register(router));

export default router;
