// ACE-Step music-generation routes. Ported from ace-step-ui's
// `server/src/routes/generate.ts`.
//
// This REPLACES ace-step-ui's in-memory `generationQueue.ts` — comfy's GPU
// scheduler (`submitGpuJob('ace-step-generate', ...)`) is the queue now.
// Slot lifetime mirrors `routes/generate.routes.ts:343`'s two-promise dance:
// the route responds as soon as ACE-Step accepts the task (so the UI gets a
// jobId + taskId to start polling `GET /status/:jobId`), but the scheduler
// slot stays held until the background poll loop reaches a terminal state
// (succeeded/failed/timeout) and downloads + persists the resulting audio.
// That way a second Generate click queues behind the first instead of both
// fighting ACE-Step (and the GPU) at once.

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import multer, { MulterError } from 'multer';
import { defineRoute, registerSpecOnly } from '../../lib/defineRoute.js';
import { NotFoundError, ValidationError, HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { submitGpuJob } from '../../services/gpu/scheduler.js';
import * as aceStep from '../../services/ace/acestep.js';
import * as storage from '../../services/ace/storage.js';
import * as aceMusicRepo from '../../lib/db/aceMusic.repo.js';
import { PACKS } from '../../services/packs/registry.js';
import { authMiddleware } from '../../middleware/auth.js';
import { generateLyrics } from './lyrics.routes.js';
import { z } from 'zod';
import {
  GenerationParamsSchema,
  GenerateSubmitResponseSchema,
  GenerationStatusParamsSchema,
  GenerationStatusResponseSchema,
  GenerationResultSchema,
  ModelsListResponseSchema,
  SimpleGenerateBodySchema,
  SimpleGenerateResponseSchema,
  RandomDescriptionQuerySchema,
  RandomDescriptionResponseSchema,
  FormatBodySchema,
  FormatResponseSchema,
  UploadAudioResponseSchema,
  AudioParamsSchema,
  type GenerationParamsInput,
} from '../../contracts/ace/generate.contract.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve one of our own `/api/ace/audio/<kind>/<key>` URLs to an absolute
 *  path. Returns null for anything else (external URL, malformed). */
function resolveLocalUrl(url: string): string | null {
  const parsed = storage.parseAudioUrl(url);
  if (!parsed) return null;
  try {
    return storage.resolveAudioAbsPath(parsed.kind, parsed.key);
  } catch {
    return null;
  }
}

// Auto-generate a song title from lyrics or style when none is provided.
function autoTitle(params: {
  title?: string; lyrics?: string; instrumental?: boolean; style?: string; songDescription?: string;
}): string {
  if (params.title?.trim()) return params.title.trim();
  if (!params.instrumental && params.lyrics) {
    for (const line of params.lyrics.split('\n')) {
      const t = line.trim();
      if (t && !/^\[.*\]$/.test(t)) {
        return t.length > 40 ? `${t.slice(0, 40).trimEnd()}…` : t;
      }
    }
  }
  const source = params.style || params.songDescription || '';
  if (source) {
    const words = source.trim().split(/\s+/).slice(0, 4).join(' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return 'Untitled';
}

function audioExtFor(format: string | undefined): string {
  if (format === 'wav32') return '.wav';
  return `.${format || 'flac'}`;
}

const POLL_INTERVAL_MS = 2000;
// Kept comfortably under TASK_TYPES['ace-step-generate'].maxRuntimeMs (30 min)
// so a real timeout fails the job with a clear message instead of getting cut
// off by the scheduler's watchdog force-release.
const MAX_WAIT_MS = 25 * 60 * 1000;

async function pollUntilTerminal(taskId: string): Promise<aceStep.TaskQueryResult> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await aceStep.queryTask(taskId).catch(() => null);
    if (!status) continue;
    if (status.completed || status.failed) return status;
  }
  return {
    completed: false,
    failed: true,
    progress: 0,
    stage: 'Timed out',
    audioFileUrls: [],
    error: 'Generation timed out after 25 minutes',
  };
}

/** Download + persist every audio file from a completed task, creating one
 *  `ace_songs` row per variation (batchSize > 1 => multiple files). */
async function persistGeneratedSongs(
  jobId: string,
  params: GenerationParamsInput,
  status: aceStep.TaskQueryResult,
): Promise<string[]> {
  const ext = audioExtFor(params.audioFormat);
  const audioUrls: string[] = [];
  const variationCount = status.audioFileUrls.length;

  for (let i = 0; i < variationCount; i += 1) {
    const songId = randomUUID();
    const variationSuffix = variationCount > 1 ? ` (v${i + 1})` : '';
    const title = autoTitle(params) + variationSuffix;
    try {
      const buffer = await aceStep.downloadAudioToBuffer(status.audioFileUrls[i]);
      const stored = await storage.saveGeneratedAudio(songId, i, buffer, ext);
      aceMusicRepo.insertSong({
        id: songId,
        title,
        lyrics: params.instrumental ? '[Instrumental]' : params.lyrics,
        style: params.style,
        caption: params.style,
        audioUrl: stored.url,
        duration: status.duration && status.duration > 0 ? status.duration : (params.duration ?? 0),
        bpm: status.bpm ?? params.bpm,
        keyScale: status.keyScale ?? params.keyScale,
        timeSignature: status.timeSignature ?? params.timeSignature,
        tags: [],
        generationParams: params,
        generationJobId: jobId,
      });
      audioUrls.push(stored.url);
    } catch {
      // Best-effort per-file: one bad download shouldn't sink the whole batch.
    }
  }
  return audioUrls;
}

// ---------------------------------------------------------------------------
// POST /ace/generate — submit a generation job
// ---------------------------------------------------------------------------

const submitRoute = defineRoute({
  method: 'POST',
  path: '/ace/generate',
  body: GenerationParamsSchema,
  response: GenerateSubmitResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Submit an ACE-Step music generation job',
}, async ({ body, ok }) => {
  if (!body.customMode && !body.songDescription) {
    throw new ValidationError('Song description required for simple mode');
  }
  if (body.customMode && !body.style && !body.lyrics && !body.referenceAudioUrl) {
    throw new ValidationError('Style, lyrics, or reference audio required for custom mode');
  }
  if ((body.taskType === 'cover' || body.taskType === 'audio2audio')
    && !body.sourceAudioUrl && !body.audioCodes) {
    throw new ValidationError(`task_type='${body.taskType}' requires source audio or audio codes`);
  }

  const jobId = randomUUID();
  aceMusicRepo.insertGenerationJob(jobId, body);

  type SubmitOutcome = { jobId: string; status: 'queued' | 'running'; taskId: string | null };
  let resolveRoute!: (v: SubmitOutcome | Promise<SubmitOutcome>) => void;
  const routePromise = new Promise<SubmitOutcome>((r) => { resolveRoute = r; });

  // Kick off the scheduler job. Do NOT await — the slot stays held while the
  // callback keeps polling. The route awaits routePromise instead, which
  // resolves the moment ACE-Step accepts the task.
  void submitGpuJob('ace-step-generate', async (release) => {
    try {
      const { taskId } = await aceStep.submitGeneration(body, resolveLocalUrl);
      aceMusicRepo.updateGenerationJob(jobId, { status: 'running', acestepTaskId: taskId });
      resolveRoute({ jobId, status: 'running', taskId });

      const finalStatus = await pollUntilTerminal(taskId);
      if (finalStatus.failed) {
        aceMusicRepo.updateGenerationJob(jobId, { status: 'failed', error: finalStatus.error ?? 'Generation failed' });
        return;
      }
      const audioUrls = await persistGeneratedSongs(jobId, body, finalStatus);
      if (audioUrls.length === 0) {
        aceMusicRepo.updateGenerationJob(jobId, { status: 'failed', error: 'ACE-Step returned no audio files' });
        return;
      }
      aceMusicRepo.updateGenerationJob(jobId, {
        status: 'succeeded',
        result: {
          audioUrls,
          duration: finalStatus.duration ?? body.duration ?? 0,
          bpm: finalStatus.bpm ?? body.bpm,
          keyScale: finalStatus.keyScale ?? body.keyScale,
          timeSignature: finalStatus.timeSignature ?? body.timeSignature,
          status: 'succeeded',
        },
      });
      aceStep.cleanupTask(taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      aceMusicRepo.updateGenerationJob(jobId, { status: 'failed', error: message });
      resolveRoute(Promise.reject(err));
    } finally {
      release();
    }
  }).catch((err) => {
    // Reaching here with the route still pending means submitGpuJob rejected
    // BEFORE run() was ever invoked — cancelled while queued, or
    // ensureResident() itself threw (it calls unloadComfy() -> waitForComfyIdle(),
    // which can block for minutes, and startAceStep()). run()'s own catch never
    // fired, so nothing has resolved routePromise and nothing has written the
    // job row. Without this the HTTP request hangs forever.
    // (services/aiToolkit/train.ts handles the same case the same way.)
    const message = err instanceof Error ? err.message : String(err);
    const job = aceMusicRepo.getGenerationJob(jobId);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      aceMusicRepo.updateGenerationJob(jobId, { status: 'failed', error: message });
    }
    resolveRoute(Promise.reject(err instanceof Error ? err : new Error(message)));
  });

  const result = await routePromise;
  return ok(result);
});

// ---------------------------------------------------------------------------
// GET /ace/generate/status/:jobId — poll a job's status
// ---------------------------------------------------------------------------

const statusRoute = defineRoute({
  method: 'GET',
  path: '/ace/generate/status/:jobId',
  params: GenerationStatusParamsSchema,
  response: GenerationStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Poll an ACE-Step generation job',
}, async ({ params, ok }) => {
  const job = aceMusicRepo.getGenerationJob(params.jobId);
  if (!job) throw new NotFoundError('Job not found');

  let progress: number | undefined;
  let stage: string | undefined;
  if ((job.status === 'queued' || job.status === 'running') && job.acestepTaskId) {
    const live = await aceStep.queryTask(job.acestepTaskId).catch(() => null);
    if (live) { progress = live.progress; stage = live.stage; }
  }

  const result = job.result as z.infer<typeof GenerationResultSchema> | null;
  return ok({
    jobId: job.id,
    status: job.status,
    progress,
    stage,
    result,
    error: job.error,
  });
});

// ---------------------------------------------------------------------------
// GET /ace/generate/models — DiT model list (installed pack checkpoints + active model)
// ---------------------------------------------------------------------------

const modelsRoute = defineRoute({
  method: 'GET',
  path: '/ace/generate/models',
  response: ModelsListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'List ACE-Step DiT models and which are downloaded/active',
}, async ({ ok }) => {
  // Checkpoint dests come from the `ace-step` pack's declarative model list
  // (services/packs/registry.ts) rather than a hardcoded ACE-Step-1.5 install
  // path — that's how comfy's pack installer lays these out on disk.
  const checkpointModels = PACKS['ace-step'].models.filter((m) => m.dest.includes(`${path.sep}checkpoints${path.sep}`));

  let activeModel: string | null = null;
  try {
    const inventory = await aceStep.getModelInventory();
    activeModel = inventory.find((m) => m.is_loaded)?.name ?? null;
  } catch {
    // ACE-Step API unavailable — fall through with no active model.
  }

  const models = checkpointModels.map((m) => {
    const name = path.basename(m.dest);
    return {
      name,
      is_active: name === activeModel,
      is_preloaded: fs.existsSync(m.dest) && fs.statSync(m.dest).isDirectory(),
    };
  });

  models.sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    if (a.is_preloaded !== b.is_preloaded) return a.is_preloaded ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return ok({ models });
});

// ---------------------------------------------------------------------------
// POST /ace/generate/simple — Simple-mode orchestration: random style + lyrics
// ---------------------------------------------------------------------------

const simpleRoute = defineRoute({
  method: 'POST',
  path: '/ace/generate/simple',
  body: SimpleGenerateBodySchema,
  response: SimpleGenerateResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Orchestrate Simple mode: resolve a style + generate matching lyrics',
}, async ({ body, ok }) => {
  const userInput = [body.genre, body.description].filter(Boolean).join(' ').trim();
  let caption = userInput;
  let language = 'en';

  if (!userInput) {
    try {
      const sample = await aceStep.getRandomSample();
      caption = sample.description || 'upbeat pop song';
      language = sample.vocalLanguage;
    } catch {
      caption = 'upbeat pop song';
    }
  }

  let lyrics = '';
  if (!body.instrumental) {
    const generated = await generateLyrics({
      genre: body.genre,
      topic: caption,
      language: language === 'unknown' ? 'english' : language,
    });
    lyrics = generated ?? '';
  }

  return ok({
    caption,
    lyrics: body.instrumental ? '[Instrumental]' : lyrics,
    language,
  });
});

// ---------------------------------------------------------------------------
// GET /ace/generate/random-description
// ---------------------------------------------------------------------------

const randomDescriptionRoute = defineRoute({
  method: 'GET',
  path: '/ace/generate/random-description',
  query: RandomDescriptionQuerySchema,
  response: RandomDescriptionResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Fetch a random Simple-mode description from ACE-Step',
}, async ({ query, ok }) => {
  const lang = query.lang;
  const maxTries = lang ? 10 : 1;
  let last: Awaited<ReturnType<typeof aceStep.getRandomSample>> | null = null;
  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    const sample = await aceStep.getRandomSample();
    last = sample;
    if (!lang || sample.vocalLanguage === lang || sample.vocalLanguage === 'unknown') {
      return ok(sample);
    }
  }
  return ok(last ?? { description: '', instrumental: false, vocalLanguage: 'unknown' });
});

// ---------------------------------------------------------------------------
// POST /ace/generate/format — LLM-assisted style/lyrics cleanup
// ---------------------------------------------------------------------------

const formatRoute = defineRoute({
  method: 'POST',
  path: '/ace/generate/format',
  body: FormatBodySchema,
  response: FormatResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Format/enhance a style + lyrics via ACE-Step\'s LLM formatter',
}, async ({ body, ok }) => {
  const result = await aceStep.formatInput(body);
  return ok({
    caption: result.caption,
    lyrics: result.lyrics,
    bpm: result.bpm,
    duration: result.duration,
    key_scale: result.keyScale,
    time_signature: result.timeSignature,
    vocal_language: result.vocalLanguage,
  });
});

// ---------------------------------------------------------------------------
// GET /ace/audio/:kind/:key — stream stored audio (generated output or an
// uploaded reference/source file). Mirrors `routes/view.routes.ts`: no
// `defineRoute`/auth wrapper because an `<audio src>` tag can't attach a
// Bearer token, and Range support needs raw `res` access. Registered via
// `registerSpecOnly` so it still shows up in the OpenAPI doc / auth audit.
// ---------------------------------------------------------------------------

registerSpecOnly({
  method: 'GET',
  path: '/ace/audio/:kind/:key',
  params: AudioParamsSchema,
  response: z.unknown(), // this route streams a binary body, not JSON
  auth: { required: false },
  tags: ['ace'],
  summary: 'Stream stored ACE-Step audio (generated output or an uploaded reference file)',
});

router.get('/ace/audio/:kind/:key', (req: Request, res: Response) => {
  const { kind, key } = req.params;
  if (typeof key !== 'string' || (kind !== 'output' && kind !== 'reference')) {
    res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid audio kind/key' } });
    return;
  }
  let absPath: string;
  try {
    absPath = storage.resolveAudioAbsPath(kind, key);
  } catch {
    res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid audio key' } });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    res.status(404).json({ error: { code: 'not_found', message: 'Audio not found' } });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: { code: 'not_found', message: 'Audio not found' } });
    return;
  }

  const contentType = storage.mimeTypeForExt(path.extname(absPath));
  const totalSize = stat.size;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < totalSize) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        res.setHeader('Content-Length', String(end - start + 1));
        fs.createReadStream(absPath, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.setHeader('Content-Length', String(totalSize));
  fs.createReadStream(absPath).pipe(res);
});

// ---------------------------------------------------------------------------
// POST /ace/generate/upload-audio — upload a reference/source audio file
// (multer needs to run before body handling, so — same as
// `routes/upload.routes.ts` — the spec is registered via `defineRoute` for
// OpenAPI/audit purposes only and the real handler is mounted manually.)
// ---------------------------------------------------------------------------

const ALLOWED_AUDIO_MIME_PREFIXES = ['audio/', 'video/mp4'];
const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.mp4', '.aac', '.ogg', '.webm', '.opus']);
const MAX_UPLOAD_AUDIO_BYTES = 25 * 1024 * 1024;

const audioUpload = multer({
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

const uploadAudioSpec = {
  method: 'POST' as const,
  path: '/ace/generate/upload-audio',
  response: UploadAudioResponseSchema,
  auth: { required: true, scopes: ['generate:write'] as const },
  tags: ['ace'],
  summary: 'Upload a reference/source audio file for cover/audio2audio generation',
};

// Registered for OpenAPI/audit visibility only — never actually invoked.
defineRoute(uploadAudioSpec, async () => ({ data: { url: '', key: '' } }));

function handleAudioUploadError(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new HttpError('payload_too_large', 'File too large', { maxBytes: MAX_UPLOAD_AUDIO_BYTES }));
    return;
  }
  next(err);
}

router.post(
  '/ace/generate/upload-audio',
  authMiddleware(uploadAudioSpec.auth),
  (req, res, next) => audioUpload.single('audio')(req, res, (err) => {
    if (err) { handleAudioUploadError(err, req, res, next); return; }
    next();
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) throw new ValidationError('Audio file is required');
      const ext = path.extname(file.originalname || '') || '.audio';
      const stored = await storage.saveReferenceAudio(file.buffer, ext);
      res.json({ data: { url: stored.url, key: stored.key } });
    } catch (err) {
      if (err instanceof Error) {
        next(err);
      } else {
        logger.error('ace upload-audio failed', { message: String(err) });
        next(new HttpError('internal_error', 'Upload failed'));
      }
    }
  },
);

[submitRoute, statusRoute, modelsRoute, simpleRoute, randomDescriptionRoute, formatRoute]
  .forEach((r) => r.register(router));

export default router;

// TODO(later agent): model download/switch (`POST /models/download`,
// `POST /models/switch`) and the GPU unload/status endpoints from
// ace-step-ui's generate.ts are intentionally not ported — model installs go
// through comfy's capability-pack subsystem (`services/packs/*`) and GPU
// residency is already owned by `services/gpu/residency.ts`
// (`ensureResident('ace-step')` / `unloadAceStep()`), so those routes would
// just be duplicate control surfaces. extract-codes / full-analysis
// (source-audio code extraction + metadata analysis for cover mode) are also
// deferred — same `/release_task` + `/query_result` polling shape as the main
// submit route, but a distinct feature; add as its own route if cover mode
// needs it before the training/LoRA agent lands.
