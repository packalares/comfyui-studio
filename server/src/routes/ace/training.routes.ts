// ACE-Step LoRA training routes. Ported from ace-step-ui's
// `server/src/routes/training.ts`.
//
// GPU-scheduler design:
//   - Every call that talks to the ACE-Step FastAPI (`services/ace/acestep.ts`'s
//     training-section functions) is wrapped in `submitGpuJob('ace-train', ...)`.
//     That both ensures ACE-Step is resident (`ensureResident('ace-step')`
//     spawns it if needed — see `services/gpu/residency.ts`) and serializes
//     against a concurrent `ace-step-generate` request, since they share the
//     same FastAPI process/GPU memory.
//   - Long-running kickoffs (preprocess, auto-label, train start) use the
//     same two-promise dance as `routes/ace/generate.routes.ts`: the route
//     resolves as soon as ACE-Step *accepts* the task, but the scheduler
//     slot is held by a background poll loop until the task reaches a
//     terminal state. `ace-train`'s `maxRuntimeMs: 0` (uncapped, see
//     `services/gpu/taskTypes.ts`) is specifically sized for this — training
//     can run for hours, and nothing else should touch the `ace-step`
//     tenant while it does.
//   - Pure status *polls* (preprocess-status, auto-label-status,
//     training-status) talk to the FastAPI directly with NO scheduler wrap —
//     wrapping them would queue every poll behind the very job it's trying
//     to observe (which holds the slot for its whole duration), starving
//     live progress entirely.
//   - Whisper transcription (`transcribe-uploads`) and audio-separator stem
//     extraction (`preprocess-stems`) are one-shot Python subprocesses, not
//     FastAPI calls — those use `submitGpuJob('ace-whisper' |
//     'ace-stem-separate', ...)` (tenant `oneshot`), which evicts
//     ollama/comfy/ACE-Step (see `services/gpu/residency.ts`) before running.
//     ace-step-ui's `ensureGpuEmptyForWhisper()` kill-hack (manual
//     `pkill -f acestep.api_server` + health-poll) is GONE — the scheduler
//     now does this correctly via `ensureResident('oneshot')`.
//
// comfy has no checked-out ACE-Step source tree (`ace-step` is a plain pip
// package here — see `services/packs/registry.ts`), so every ace-step-ui
// path that resolved relative to `getAceStepDir()` (checkpoints/, lora
// output, arbitrary directory scans) is re-anchored to comfy's own
// `paths.ace*` roots instead, guarded by `safeResolve` against traversal.
// Routes that only make sense against a source checkout (`GET /audio` raw
// file proxy, `POST /scan-directory` for an arbitrary directory,
// `/save-dataset`, `/load-tensors`, `/cleanup-artifacts`, `/export`) are not
// ported — see the bottom-of-file TODO.

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import path from 'path';
import fs from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { defineRoute } from '../../lib/defineRoute.js';
import { HttpError, NotFoundError, UpstreamUnavailableError, ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { authMiddleware } from '../../middleware/auth.js';
import { safeResolve } from '../../lib/fs.js';
import { run } from '../../lib/exec.js';
import { paths } from '../../config/paths.js';
import { submitGpuJob } from '../../services/gpu/scheduler.js';
import * as aceStep from '../../services/ace/acestep.js';
import * as audioSeparator from '../../services/ace/audioSeparator.js';
import * as stemJobs from '../../services/ace/stemJobs.js';
import * as aceTrainingRepo from '../../lib/db/aceTraining.repo.js';
import { broadcastAce } from '../../services/ace/broadcaster.js';
import { PACKS } from '../../services/packs/registry.js';
import { effectiveDest, effectiveRepo } from '../../services/packs/settings.js';
import {
  UploadTrainingAudioResponseSchema,
  TranscribeUploadsBodySchema,
  TranscribeUploadsResponseSchema,
  TranscribeUploadsStatusQuerySchema,
  TranscribeUploadsStatusResponseSchema,
  BuildDatasetBodySchema,
  BuildDatasetResponseSchema,
  PreprocessBodySchema,
  PreprocessResponseSchema,
  PreprocessStatusResponseSchema,
  AutoLabelBodySchema,
  AutoLabelResponseSchema,
  AutoLabelStatusResponseSchema,
  InitModelBodySchema,
  InitModelResponseSchema,
  CheckpointsListResponseSchema,
  LoraCheckpointsQuerySchema,
  LoraCheckpointsResponseSchema,
  LoadDatasetBodySchema,
  LoadDatasetResponseSchema,
  SamplePreviewQuerySchema,
  SamplePreviewResponseSchema,
  SaveSampleBodySchema,
  SaveSampleResponseSchema,
  UpdateTrainingSettingsBodySchema,
  UpdateTrainingSettingsResponseSchema,
  StartTrainingBodySchema,
  StartTrainingResponseSchema,
  TrainingStatusResponseSchema,
  StopTrainingResponseSchema,
  PreprocessStemsBodySchema,
  PreprocessStemsResponseSchema,
  PreprocessStemsStatusQuerySchema,
  PreprocessStemsStatusResponseSchema,
  TrainingLimitsResponseSchema,
  TrainingSampleSchema,
} from '../../contracts/ace/training.contract.js';
import type { z } from 'zod';

const router = Router();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.opus']);

// ---------------------------------------------------------------------------
// Whisper batch-transcription job tracking.
//
// ACE-Step's own long operations (auto-label, preprocess) expose an async
// task_id we can hand straight back to the client. `runWhisperBatch` has no
// such upstream handle — it's a local subprocess that runs to completion — so
// awaiting it inside the handler held the HTTP response open for the entire
// run (up to the 20-minute `ace-whisper` cap) plus any time spent queued
// behind the single GPU slot. Behind an ingress with a 30-60s timeout that is
// a 504 with the transcription still running, orphaned and unpollable.
// Track it in-process instead: POST registers and returns, client polls
// `GET /ace/training/transcribe-uploads-status`.
// ---------------------------------------------------------------------------

type TranscribeJobState = {
  status: 'running' | 'succeeded' | 'failed';
  dir: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  lines: string[];
};

/** Keyed by sanitized dataset name — one transcription per dataset at a time. */
const transcribeJobs = new Map<string, TranscribeJobState>();
const TRANSCRIBE_LOG_TAIL = 200;
const TRANSCRIBE_JOB_TTL_MS = 30 * 60 * 1000;

/** Push a `{type:'ace:training', data:{kind:'whisper', ...}}` frame whenever
 *  a whisper batch-transcription job changes — mirrors the shape
 *  `GET /transcribe-uploads-status` returns so a client that reconciles via
 *  that route on mount and then subscribes to this broadcast never sees a
 *  shape mismatch. */
function broadcastTranscribeJob(datasetName: string, job: TranscribeJobState): void {
  broadcastAce('ace:training', {
    kind: 'whisper',
    datasetName,
    status: job.status,
    dir: job.dir,
    error: job.error,
    lines: job.lines.slice(-TRANSCRIBE_LOG_TAIL),
  });
}

/** Dataset/persona names become filesystem path components (upload folder,
 *  dataset JSON filename). Strip everything except a safe identifier charset
 *  so no traversal or absolute-path injection is possible regardless of
 *  client input. */
function sanitizeName(name: string | undefined, fallback = 'default'): string {
  const trimmed = (name ?? '').trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9_-]/g, '_');
  return safe || fallback;
}

/** Concurrency-bounded `Array.map` for async work. Used where each callback
 *  spawns a subprocess, so an unbounded `Promise.all` would fork one process
 *  per element all at once. Preserves input order in the result. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const FFPROBE_CONCURRENCY = 8;

async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const result = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeoutMs: 10_000 });
    if (result.code !== 0) return 0;
    const duration = parseFloat(result.stdout.trim());
    return Number.isNaN(duration) ? 0 : Math.round(duration);
  } catch {
    return 0;
  }
}

/** Resolve a client-supplied path (relative OR already-absolute, e.g. one
 *  this same route handed back from an earlier build-dataset/load-dataset
 *  call) so it can never escape `root`. Throws `ValidationError` on escape —
 *  `safeResolve` treats an absolute segment outside `root` as an escape,
 *  which is exactly the traversal guard wanted here. */
function resolveUnder(root: string, given: string, label: string): string {
  try {
    return safeResolve(root, given);
  } catch {
    throw new ValidationError(`${label} must be inside its expected directory`);
  }
}

// Trainer saves the finished LoRA to `<output_dir>/final/adapter` — that's
// the real PEFT directory containing `adapter_config.json`. Older/partial
// runs may only have `<output_dir>/final`. Prefer the adapter subdir when it
// exists. (ace-step-ui's fixed logic — preserved verbatim.)
function resolveFinalCheckpointDir(finalDir: string): string {
  const adapterDir = path.join(finalDir, 'adapter');
  if (fs.existsSync(path.join(adapterDir, 'adapter_config.json'))) {
    return adapterDir;
  }
  return finalDir;
}

// Recursively collects LoRA checkpoints starting at `dir`. A "training root"
// is any directory with a `checkpoints/` and/or `final/` child; personas are
// nested under category subdirs (e.g. `voice/voice_sinulescu/final/adapter`),
// so we walk into other subdirectories too, bounded by maxDepth. (ace-step-ui's
// fixed logic — preserved verbatim, only `getAceStepDir()` dropped.)
function collectLoraCheckpoints(dir: string, maxDepth = 4): string[] {
  const checkpoints: string[] = [];
  if (!fs.existsSync(dir)) return checkpoints;

  const checkpointsDir = path.join(dir, 'checkpoints');
  if (fs.existsSync(checkpointsDir)) {
    fs.readdirSync(checkpointsDir).forEach((e) => {
      const fullPath = path.join(checkpointsDir, e);
      if (fs.statSync(fullPath).isDirectory()) {
        checkpoints.push(fullPath);
      }
    });
  }

  const finalDir = path.join(dir, 'final');
  if (fs.existsSync(finalDir)) {
    checkpoints.push(resolveFinalCheckpointDir(finalDir));
  }

  if (maxDepth > 0) {
    fs.readdirSync(dir).forEach((e) => {
      if (e === 'checkpoints' || e === 'final') return;
      const fullPath = path.join(dir, e);
      if (fs.statSync(fullPath).isDirectory()) {
        checkpoints.push(...collectLoraCheckpoints(fullPath, maxDepth - 1));
      }
    });
  }

  return checkpoints;
}

type TrainingSample = z.infer<typeof TrainingSampleSchema>;

/** Map either ACE-Step's FastAPI sample dict OR our own locally-built
 *  sample dict (build-dataset, before it's ever round-tripped through
 *  FastAPI) to the wire shape — field names differ slightly between the two
 *  sources (`audio_path` vs `audio`, `keyscale` vs `key`, ...). */
function mapSample(raw: Record<string, unknown> | null | undefined): TrainingSample | null {
  if (!raw) return null;
  return {
    index: typeof raw.index === 'number' ? raw.index : undefined,
    audio: (raw.audio_path as string | undefined) ?? (raw.audio as string | undefined) ?? null,
    filename: String(raw.filename ?? ''),
    caption: String(raw.caption ?? ''),
    genre: String(raw.genre ?? ''),
    promptOverride: (raw.prompt_override as string | null | undefined)
      ?? (raw.promptOverride as string | null | undefined) ?? null,
    lyrics: String(raw.lyrics ?? ''),
    bpm: (raw.bpm as number | null | undefined) ?? null,
    key: String(raw.keyscale ?? raw.key ?? ''),
    timeSignature: String(raw.timesignature ?? raw.timeSignature ?? ''),
    duration: Number(raw.duration ?? 0),
    language: String(raw.language ?? 'unknown'),
    instrumental: Boolean(raw.is_instrumental ?? raw.instrumental ?? false),
    rawLyrics: String(raw.raw_lyrics ?? raw.rawLyrics ?? ''),
  };
}

/**
 * Best-effort "is this FastAPI background task still active" probe. ACE-Step's
 * exact status-response schema wasn't available to confirm against while
 * porting this (it lives in the upstream ACE-Step-1.5 source, not in this
 * checkout) — this checks a handful of plausible boolean flag names and
 * falls back to a hard timeout so a wrong guess can't hold the GPU slot
 * forever. TODO: confirm the real field name(s) against a running ACE-Step
 * instance and simplify this to a direct field check.
 */
function looksActive(status: Record<string, unknown>): boolean {
  const d = (status.data ?? status) as Record<string, unknown>;
  const flags = ['is_processing', 'is_running', 'processing', 'running', 'is_active', 'is_training'];
  return flags.some((k) => d[k] === true);
}

/** `kind` tags every push as `{type:'ace:training', data:{kind, raw}}` so
 *  `TrainTab` can subscribe once and route by `kind` instead of running
 *  three separate polling loops (`pollGeneric` against preprocess-status /
 *  auto-label-status / training-status). This loop already fetches the
 *  FastAPI status on an interval to know when to release the GPU slot —
 *  broadcasting each fetch here (deduped against the previous one so an
 *  unchanged snapshot doesn't spam a frame) means the client no longer needs
 *  its own poll loop for the common case; `GET` the same status route once
 *  on mount / after a dropped socket remains the fallback + reconciliation
 *  path. */
async function pollUntilInactive(
  fetchStatus: () => Promise<Record<string, unknown>>,
  maxWaitMs: number,
  settleDelayMs = 2000,
  pollIntervalMs = 3000,
  kind?: 'preprocess' | 'autoLabel' | 'train',
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let lastJson = '';
  const broadcastStatus = (raw: Record<string, unknown>): void => {
    if (!kind) return;
    const json = JSON.stringify(raw);
    if (json === lastJson) return;
    lastJson = json;
    broadcastAce('ace:training', { kind, raw });
  };
  // Give the FastAPI task a moment to actually start before checking —
  // otherwise a not-yet-started task looks identical to a finished one.
  await new Promise((r) => setTimeout(r, settleDelayMs));
  while (Date.now() < deadline) {
    let status: Record<string, unknown> | null = null;
    try {
      status = await fetchStatus();
    } catch {
      // Transient — FastAPI may be mid-restart; keep polling.
    }
    if (status) {
      broadcastStatus(status);
      if (!looksActive(status)) return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  logger.warn('[ace-training] pollUntilInactive hit its max-wait ceiling; releasing anyway', { maxWaitMs });
}

const PREPROCESS_MAX_WAIT_MS = 2 * 60 * 60 * 1000; // 2h
const AUTO_LABEL_MAX_WAIT_MS = 2 * 60 * 60 * 1000; // 2h
const TRAINING_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — LoRA runs can take a long time.

// ---------------------------------------------------------------------------
// POST /ace/training/upload-audio — multipart; spec registered via
// `defineRoute` for OpenAPI/audit purposes only (multer must run before body
// handling — same pattern as `routes/ace/generate.routes.ts`'s upload-audio).
// ---------------------------------------------------------------------------

const audioUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const datasetName = sanitizeName((req.body as Record<string, unknown> | undefined)?.datasetName as string | undefined);
      let dest: string;
      try {
        dest = safeResolve(paths.aceDatasetUploadsDir, datasetName);
      } catch (err) {
        cb(err as Error, paths.aceDatasetUploadsDir);
        return;
      }
      fs.mkdir(dest, { recursive: true }, (err) => cb(err, dest));
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-. ]/g, '_');
      cb(null, `${base}${ext}`);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new ValidationError(`Unsupported file type: ${ext}. Allowed: ${[...AUDIO_EXTENSIONS].join(', ')}`));
    }
  },
});

const uploadAudioSpec = {
  method: 'POST' as const,
  path: '/ace/training/upload-audio',
  response: UploadTrainingAudioResponseSchema,
  auth: { required: true, scopes: ['generate:write'] as const },
  tags: ['ace'],
  summary: 'Upload audio files for a LoRA training dataset',
};

// Registered for OpenAPI/audit visibility only — never actually invoked.
defineRoute(uploadAudioSpec, async () => ({ data: { files: [], uploadDir: '', count: 0 } }));

function handleUploadError(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    next(new HttpError('payload_too_large', 'File too large', { maxBytes: 100 * 1024 * 1024 }));
    return;
  }
  next(err);
}

router.post(
  '/ace/training/upload-audio',
  authMiddleware(uploadAudioSpec.auth),
  (req, res, next) => audioUpload.array('audio', 50)(req, res, (err) => {
    if (err) { handleUploadError(err, req, res, next); return; }
    next();
  }),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!Array.isArray(files) || files.length === 0) throw new ValidationError('No audio files uploaded');
      const datasetName = sanitizeName((req.body as Record<string, unknown>)?.datasetName as string | undefined);
      const uploadDir = safeResolve(paths.aceDatasetUploadsDir, datasetName);
      res.json({
        data: {
          files: files.map((f) => ({
            filename: f.filename,
            originalName: f.originalname,
            size: f.size,
            path: f.path,
          })),
          uploadDir,
          count: files.length,
        },
      });
    } catch (err) {
      if (err instanceof Error) next(err);
      else next(new HttpError('internal_error', 'Upload failed'));
    }
  },
);

// ---------------------------------------------------------------------------
// POST /ace/training/transcribe-uploads
// ---------------------------------------------------------------------------

const transcribeUploadsRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/transcribe-uploads',
  body: TranscribeUploadsBodySchema,
  response: TranscribeUploadsResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Batch-transcribe a dataset\'s uploaded audio via faster-whisper',
}, async ({ body, ok }) => {
  const datasetName = sanitizeName(body.datasetName);
  const audioDir = safeResolve(paths.aceDatasetUploadsDir, datasetName);
  if (!fs.existsSync(audioDir)) {
    throw new ValidationError(`Upload directory not found for dataset: ${datasetName}`);
  }

  // Already transcribing this dataset — report that instead of queueing a
  // second whisper run over the same directory.
  const inFlight = transcribeJobs.get(datasetName);
  if (inFlight?.status === 'running') {
    return ok({ status: 'running', dir: inFlight.dir });
  }

  const job: TranscribeJobState = {
    status: 'running', dir: audioDir, startedAt: Date.now(), lines: [],
  };
  transcribeJobs.set(datasetName, job);
  broadcastTranscribeJob(datasetName, job);

  const finish = (patch: Partial<TranscribeJobState>): void => {
    Object.assign(job, patch, { finishedAt: Date.now() });
    broadcastTranscribeJob(datasetName, job);
    // Keep the terminal state around long enough for a mid-poll client to
    // observe it, then drop it so the map can't grow without bound.
    setTimeout(() => {
      if (transcribeJobs.get(datasetName) === job) transcribeJobs.delete(datasetName);
    }, TRANSCRIBE_JOB_TTL_MS).unref();
  };

  void submitGpuJob('ace-whisper', async (release) => {
    try {
      await audioSeparator.runWhisperBatch(audioDir, (line) => {
        logger.info(`[whisper] ${line}`);
        job.lines.push(line);
        if (job.lines.length > TRANSCRIBE_LOG_TAIL) job.lines.shift();
        broadcastTranscribeJob(datasetName, job);
      });
      finish({ status: 'succeeded' });
    } catch (err) {
      finish({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      release();
    }
  }).catch((err) => {
    // submitGpuJob rejected before run() ever executed — cancelled while
    // queued, or ensureResident() itself threw. run()'s catch never fired, so
    // without this the job would sit at 'running' forever and the client would
    // poll indefinitely.
    if (job.status === 'running') {
      finish({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  });

  return ok({ status: 'started', dir: audioDir });
});

const transcribeUploadsStatusRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/transcribe-uploads-status',
  query: TranscribeUploadsStatusQuerySchema,
  response: TranscribeUploadsStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Poll batch Whisper transcription progress',
}, async ({ query, ok }) => {
  const job = transcribeJobs.get(sanitizeName(query.datasetName));
  if (!job) return ok({ status: 'idle' as const, lines: [] });
  return ok({
    status: job.status,
    dir: job.dir,
    error: job.error,
    lines: job.lines.slice(-50),
  });
});

// ---------------------------------------------------------------------------
// POST /ace/training/build-dataset
// ---------------------------------------------------------------------------

const buildDatasetRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/build-dataset',
  body: BuildDatasetBodySchema,
  response: BuildDatasetResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Scan an uploaded-audio directory and build a training dataset JSON',
}, async ({ body, ok }) => {
  const datasetName = sanitizeName(body.datasetName, 'my_lora_dataset');
  const audioDir = safeResolve(paths.aceDatasetUploadsDir, datasetName);
  if (!fs.existsSync(audioDir)) {
    throw new ValidationError(`Audio directory not found for dataset: ${datasetName}`);
  }

  const entries = fs.readdirSync(audioDir);
  const audioFiles = entries.filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  if (audioFiles.length === 0) {
    throw new ValidationError('No audio files found in directory');
  }

  // Bounded, NOT Promise.all over every file: each callback spawns an
  // `ffprobe` subprocess, so an unbounded map on a few-hundred-file dataset
  // would fork hundreds of processes at once and can exhaust PIDs/file
  // descriptors on the box. FFPROBE_CONCURRENCY keeps it fast without the
  // spawn storm.
  const samples = await mapWithConcurrency(audioFiles, FFPROBE_CONCURRENCY, async (filename) => {
    const audioPath = path.join(audioDir, filename);
    const duration = await getAudioDuration(audioPath);
    const baseName = path.basename(filename, path.extname(filename));

    let rawLyrics = '';
    const lyricsPath = path.join(audioDir, `${baseName}.txt`);
    if (fs.existsSync(lyricsPath)) {
      try { rawLyrics = (await readFile(lyricsPath, 'utf-8')).trim(); } catch { /* ignore */ }
    }

    let detectedLang = '';
    const langPath = path.join(audioDir, `${baseName}.lang.txt`);
    if (fs.existsSync(langPath)) {
      try { detectedLang = (await readFile(langPath, 'utf-8')).trim(); } catch { /* ignore */ }
    }

    const isInstrumental = body.allInstrumental || !rawLyrics;

    return {
      id: randomUUID().slice(0, 8),
      audio_path: audioPath,
      filename,
      caption: '',
      genre: '',
      lyrics: isInstrumental ? '[Instrumental]' : rawLyrics,
      raw_lyrics: rawLyrics,
      formatted_lyrics: '',
      bpm: null as number | null,
      keyscale: '',
      timesignature: '',
      duration,
      language: isInstrumental ? 'instrumental' : (detectedLang || 'unknown'),
      is_instrumental: isInstrumental,
      custom_tag: body.customTag,
      labeled: false,
      prompt_override: null as string | null,
    };
  });

  const dataset = {
    metadata: {
      name: datasetName,
      custom_tag: body.customTag,
      tag_position: body.tagPosition,
      created_at: new Date().toISOString(),
      num_samples: samples.length,
      all_instrumental: body.allInstrumental,
      genre_ratio: 0,
    },
    samples,
  };

  await mkdir(paths.aceDatasetsDir, { recursive: true });
  const jsonPath = safeResolve(paths.aceDatasetsDir, `${datasetName}.json`);
  await writeFile(jsonPath, JSON.stringify(dataset, null, 2), 'utf-8');

  aceTrainingRepo.upsertTrainingDataset({
    id: randomUUID(),
    name: datasetName,
    datasetPath: jsonPath,
    sampleCount: samples.length,
    customTag: body.customTag,
    tagPosition: body.tagPosition,
    allInstrumental: body.allInstrumental,
  });

  const settings = {
    datasetName,
    customTag: body.customTag,
    tagPosition: body.tagPosition,
    allInstrumental: body.allInstrumental,
    genreRatio: 0,
  };

  // Best-effort live preview: load into ACE-Step's FastAPI if it's
  // reachable. Not fatal if unavailable — the dataset JSON is already saved.
  let dataframe: unknown = null;
  let status = `Dataset saved (${samples.length} samples). ACE-Step API not available for live preview.`;
  try {
    const loaded = await submitGpuJob('ace-train', async (release) => {
      try {
        return await aceStep.loadDataset(jsonPath);
      } finally {
        release();
      }
    });
    dataframe = loaded.dataframe;
    status = loaded.status;
  } catch (err) {
    logger.warn('[ace-training] build-dataset: ACE-Step preview load failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const firstSample = mapSample(samples[0] as unknown as Record<string, unknown>);
  return ok({ status, dataframe, sampleCount: samples.length, sample: firstSample, settings, datasetPath: jsonPath });
});

// ---------------------------------------------------------------------------
// POST /ace/training/preprocess + GET /ace/training/preprocess-status
// ---------------------------------------------------------------------------

const preprocessRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/preprocess',
  body: PreprocessBodySchema,
  response: PreprocessResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Start async tensor preprocessing for a dataset via ACE-Step',
}, async ({ body, ok }) => {
  const datasetPath = resolveUnder(paths.aceDatasetsDir, body.datasetPath, 'datasetPath');
  const outputDir = body.outputDir
    ? resolveUnder(paths.aceDatasetsDir, body.outputDir, 'outputDir')
    : path.join(paths.aceDatasetsDir, 'preprocessed_tensors');

  type Outcome = { task_id?: string; status: string };
  let resolveRoute!: (v: Outcome | Promise<Outcome>) => void;
  const routePromise = new Promise<Outcome>((r) => { resolveRoute = r; });

  void submitGpuJob('ace-train', async (release) => {
    try {
      const started = await aceStep.preprocessDatasetAsync(datasetPath, outputDir);
      resolveRoute({ task_id: started.taskId, status: started.status });
      await pollUntilInactive(() => aceStep.getPreprocessStatus(), PREPROCESS_MAX_WAIT_MS, undefined, undefined, 'preprocess');
    } catch (err) {
      resolveRoute(Promise.reject(err));
    } finally {
      release();
    }
  }).catch(() => { /* errors already routed via resolveRoute */ });

  return ok(await routePromise);
});

const preprocessStatusRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/preprocess-status',
  response: PreprocessStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Poll dataset preprocessing progress (direct FastAPI proxy, no GPU-scheduler wrap)',
}, async ({ ok }) => ok(await aceStep.getPreprocessStatus()));

// ---------------------------------------------------------------------------
// POST /ace/training/auto-label + GET /ace/training/auto-label-status
// ---------------------------------------------------------------------------

const autoLabelRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/auto-label',
  body: AutoLabelBodySchema,
  response: AutoLabelResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Auto-label the loaded dataset\'s samples via ACE-Step\'s 5Hz LM',
}, async ({ body, ok }) => {
  type Outcome = { task_id?: string; total?: number; status: string };
  let resolveRoute!: (v: Outcome | Promise<Outcome>) => void;
  const routePromise = new Promise<Outcome>((r) => { resolveRoute = r; });

  void submitGpuJob('ace-train', async (release) => {
    try {
      const started = await aceStep.autoLabelDatasetAsync(body);
      resolveRoute({ task_id: started.taskId, total: started.total, status: started.status });
      await pollUntilInactive(() => aceStep.getAutoLabelStatus(), AUTO_LABEL_MAX_WAIT_MS, undefined, undefined, 'autoLabel');
    } catch (err) {
      resolveRoute(Promise.reject(err));
    } finally {
      release();
    }
  }).catch(() => { /* errors already routed via resolveRoute */ });

  return ok(await routePromise);
});

const autoLabelStatusRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/auto-label-status',
  response: AutoLabelStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Poll auto-labeling progress (direct FastAPI proxy, no GPU-scheduler wrap)',
}, async ({ ok }) => ok(await aceStep.getAutoLabelStatus()));

// ---------------------------------------------------------------------------
// POST /ace/training/init-model
// ---------------------------------------------------------------------------

const initModelRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/init-model',
  body: InitModelBodySchema,
  response: InitModelResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Initialize/switch the model ACE-Step trains against',
}, async ({ body, ok }) => submitGpuJob('ace-train', async (release) => {
  try {
    if (body.reinitialize) await aceStep.reinitializeModel();
    const result = await aceStep.initModelForTraining({
      checkpoint: body.checkpoint,
      initLlm: body.initLlm,
      lmModelPath: body.lmModelPath,
    });
    return ok(result);
  } finally {
    release();
  }
}));

// ---------------------------------------------------------------------------
// GET /ace/training/checkpoints — DiT checkpoints the `ace-step` pack
// installed (registry.ts), not a scan of a source checkout.
// ---------------------------------------------------------------------------

const checkpointsRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/checkpoints',
  response: CheckpointsListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'List installed ACE-Step DiT checkpoints available to train against',
}, ({ ok }) => {
  const checkpointModels = PACKS['ace-step'].models.filter((m) => m.kind === 'checkpoint');
  const checkpoints = checkpointModels
    .map((m) => effectiveDest('ace-step', m.id, m.kind, effectiveRepo('ace-step', m.id, m.repo)))
    .filter((dest) => fs.existsSync(dest) && fs.statSync(dest).isDirectory())
    .map((dest) => path.basename(dest));
  // ace-step-ui separately listed `acestep-v15-*` config directories; every
  // fixed checkpoint dest here already matches that naming convention, so
  // the two lists are equivalent in comfy's case.
  const configs = checkpoints.filter((name) => name.startsWith('acestep-v15'));
  return ok({ checkpoints, configs });
});

// ---------------------------------------------------------------------------
// GET /ace/training/lora-checkpoints
// ---------------------------------------------------------------------------

const loraCheckpointsRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/lora-checkpoints',
  query: LoraCheckpointsQuerySchema,
  response: LoraCheckpointsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'List trained LoRA checkpoints under the training output directory',
}, ({ query, ok }) => {
  const resolvedDir = query.dir
    ? resolveUnder(paths.aceLoraOutputDir, query.dir, 'dir')
    : paths.aceLoraOutputDir;
  if (!fs.existsSync(resolvedDir)) {
    return ok({ checkpoints: [] });
  }
  const checkpoints = collectLoraCheckpoints(resolvedDir);
  return ok({ checkpoints, outputDir: resolvedDir });
});

// ---------------------------------------------------------------------------
// POST /ace/training/load-dataset
// ---------------------------------------------------------------------------

const loadDatasetRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/load-dataset',
  body: LoadDatasetBodySchema,
  response: LoadDatasetResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Load an existing dataset JSON into ACE-Step for preprocessing/training',
}, async ({ body, ok }) => {
  const datasetPath = resolveUnder(paths.aceDatasetsDir, body.datasetPath, 'datasetPath');

  const loaded = await submitGpuJob('ace-train', async (release) => {
    try {
      return await aceStep.loadDataset(datasetPath);
    } finally {
      release();
    }
  });

  let metadata: Record<string, unknown> = {};
  try {
    const raw = await readFile(datasetPath, 'utf-8');
    const parsed = JSON.parse(raw) as { metadata?: Record<string, unknown> };
    metadata = parsed.metadata ?? {};
  } catch {
    // settings fall back to defaults below
  }

  const settings = {
    datasetName: String(metadata.name ?? loaded.datasetName ?? 'untitled'),
    customTag: String(metadata.custom_tag ?? ''),
    tagPosition: String(metadata.tag_position ?? 'prepend'),
    allInstrumental: Boolean(metadata.all_instrumental ?? false),
    genreRatio: Number(metadata.genre_ratio ?? 0),
  };

  aceTrainingRepo.upsertTrainingDataset({
    id: randomUUID(),
    name: settings.datasetName,
    datasetPath,
    sampleCount: loaded.sampleCount,
    customTag: settings.customTag,
    tagPosition: settings.tagPosition,
    allInstrumental: settings.allInstrumental,
    genreRatio: settings.genreRatio,
  });

  return ok({
    status: loaded.status,
    dataframe: loaded.dataframe,
    sampleCount: loaded.sampleCount,
    sample: mapSample(loaded.samples[0]),
    settings,
    datasetPath,
  });
});

// ---------------------------------------------------------------------------
// GET /ace/training/sample-preview
// ---------------------------------------------------------------------------

const samplePreviewRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/sample-preview',
  query: SamplePreviewQuerySchema,
  response: SamplePreviewResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Preview a single dataset sample by index',
}, async ({ query, ok }) => {
  const sample = await submitGpuJob('ace-train', async (release) => {
    try {
      return await aceStep.getDatasetSample(query.idx);
    } finally {
      release();
    }
  });
  const mapped = mapSample(sample);
  if (!mapped) throw new NotFoundError('Sample not found');
  return ok(mapped);
});

// ---------------------------------------------------------------------------
// POST /ace/training/save-sample
// ---------------------------------------------------------------------------

const saveSampleRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/save-sample',
  body: SaveSampleBodySchema,
  response: SaveSampleResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Save edits to a dataset sample',
}, async ({ body, ok }) => submitGpuJob('ace-train', async (release) => {
  try {
    return ok(await aceStep.saveDatasetSample({
      sampleIdx: body.sampleIdx,
      caption: body.caption,
      genre: body.genre,
      promptOverride: body.promptOverride ?? null,
      lyrics: body.lyrics,
      bpm: body.bpm ?? null,
      keyscale: body.key,
      timesignature: body.timeSignature,
      language: body.language,
      instrumental: body.instrumental,
    }));
  } finally {
    release();
  }
}));

// ---------------------------------------------------------------------------
// POST /ace/training/update-settings — ace-step-ui's handler is a no-op.
// ---------------------------------------------------------------------------

const updateSettingsRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/update-settings',
  body: UpdateTrainingSettingsBodySchema,
  response: UpdateTrainingSettingsResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Acknowledge a dataset-settings save (no server-side effect, matches ace-step-ui)',
}, ({ ok }) => ok({ success: true }));

// ---------------------------------------------------------------------------
// POST /ace/training/start + POST /ace/training/stop + GET /training-status
// ---------------------------------------------------------------------------

const startTrainingRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/start',
  body: StartTrainingBodySchema,
  response: StartTrainingResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Start LoRA training against the currently-loaded, preprocessed dataset',
}, async ({ body, ok }) => {
  const tensorDir = body.tensorDir
    ? resolveUnder(paths.aceDatasetsDir, body.tensorDir, 'tensorDir')
    : path.join(paths.aceDatasetsDir, 'preprocessed_tensors');
  const outputDir = body.outputDir
    ? resolveUnder(paths.aceLoraOutputDir, body.outputDir, 'outputDir')
    : paths.aceLoraOutputDir;

  const runId = randomUUID();
  aceTrainingRepo.insertTrainingRun({
    id: runId,
    datasetName: body.datasetName ?? null,
    tensorDir,
    outputDir,
    hyperparams: body,
  });

  type Outcome = { runId: string; status?: string; raw?: Record<string, unknown> };
  let resolveRoute!: (v: Outcome | Promise<Outcome>) => void;
  const routePromise = new Promise<Outcome>((r) => { resolveRoute = r; });

  void submitGpuJob('ace-train', async (release) => {
    try {
      const raw = await aceStep.startTraining({
        tensorDir,
        rank: body.rank,
        alpha: body.alpha,
        dropout: body.dropout,
        learningRate: body.learningRate,
        epochs: body.epochs,
        batchSize: body.batchSize,
        gradientAccumulation: body.gradientAccumulation,
        saveEvery: body.saveEvery,
        shift: body.shift,
        seed: body.seed,
        outputDir,
        resumeCheckpoint: body.resumeCheckpoint,
      });
      const status = typeof raw.status === 'string' ? raw.status : undefined;
      resolveRoute({ runId, status, raw });
      await pollUntilInactive(() => aceStep.getTrainingStatus(), TRAINING_MAX_WAIT_MS, undefined, undefined, 'train');
      aceTrainingRepo.updateTrainingRun(runId, { status: 'succeeded', finishedAt: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      aceTrainingRepo.updateTrainingRun(runId, { status: 'failed', error: message, finishedAt: Date.now() });
      resolveRoute(Promise.reject(err));
    } finally {
      release();
    }
  }).catch(() => { /* errors already routed via resolveRoute / the run row */ });

  return ok(await routePromise);
});

const trainingStatusRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/training-status',
  response: TrainingStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Poll LoRA training progress (direct FastAPI proxy, no GPU-scheduler wrap)',
}, async ({ ok }) => ok(await aceStep.getTrainingStatus()));

const stopTrainingRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/stop',
  response: StopTrainingResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Stop the currently running LoRA training run',
}, async ({ ok }) => {
  const raw = await submitGpuJob('ace-train', async (release) => {
    try {
      return await aceStep.stopTraining();
    } finally {
      release();
    }
  });
  const latest = aceTrainingRepo.getLatestTrainingRun();
  if (latest && latest.status === 'running') {
    aceTrainingRepo.updateTrainingRun(latest.id, { status: 'stopped', finishedAt: Date.now() });
  }
  return ok(raw);
});

// ---------------------------------------------------------------------------
// POST /ace/training/preprocess-stems + GET /preprocess-stems-status
// (audio-separator-based training-data preprocessing)
// ---------------------------------------------------------------------------

const preprocessStemsRoute = defineRoute({
  method: 'POST',
  path: '/ace/training/preprocess-stems',
  body: PreprocessStemsBodySchema,
  response: PreprocessStemsResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Extract stems (vocals/instrumental) from a dataset\'s uploads via audio-separator',
}, ({ body, ok }) => {
  const datasetName = sanitizeName(body.datasetName);
  const inputDir = safeResolve(paths.aceDatasetUploadsDir, datasetName);
  if (!fs.existsSync(inputDir)) {
    throw new NotFoundError(`Dataset not found: ${datasetName}`);
  }

  const inputs = fs.readdirSync(inputDir)
    .filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(inputDir, f));
  if (inputs.length === 0) {
    throw new ValidationError('No audio files found in dataset uploads');
  }

  const outputDatasetName = `${datasetName}_stems`;
  const outputDir = safeResolve(paths.aceDatasetUploadsDir, outputDatasetName);
  const { model, keepStems, chain, extraArgs } = body.preprocessing;

  const job = stemJobs.createJob(inputs.length);

  void submitGpuJob('ace-stem-separate', async (release) => {
    try {
      stemJobs.updateJob(job.id, { status: 'running' });
      await mkdir(outputDir, { recursive: true });
      const result = await audioSeparator.separateStems({
        inputPaths: inputs,
        outputDir,
        model,
        keepStems,
        chain,
        extraArgs,
        onStdout: (line) => stemJobs.updateJob(job.id, { appendLog: line }),
        onProgress: (msg) => {
          const m = /(\d+)\s*%/.exec(msg);
          if (!m) return;
          const cur = stemJobs.getJob(job.id);
          if (!cur) return;
          const filePct = parseInt(m[1], 10);
          const overall = Math.round((cur.current * 100 + filePct) / cur.total);
          stemJobs.updateJob(job.id, { progress: Math.min(99, overall) });
        },
      });
      stemJobs.updateJob(job.id, {
        status: 'completed',
        progress: 100,
        current: inputs.length,
        result: result as unknown as Record<string, unknown>,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stemJobs.updateJob(job.id, { status: 'failed', error: message });
    } finally {
      release();
    }
  }).catch(() => { /* terminal state already recorded on the job row above */ });

  return ok({
    jobId: job.id,
    total: inputs.length,
    category: body.category,
    subType: body.subType ?? null,
    outputDatasetName,
    outputDir,
  });
});

const preprocessStemsStatusRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/preprocess-stems-status',
  query: PreprocessStemsStatusQuerySchema,
  response: PreprocessStemsStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Poll a stem-extraction job',
}, ({ query, ok }) => {
  const job = stemJobs.getJob(query.jobId);
  if (!job) throw new NotFoundError('Job not found');
  return ok(job);
});

// ---------------------------------------------------------------------------
// GET /ace/training/limits — GPU tier probe. No GPU-scheduler wrap: unlike
// the ACE-Step FastAPI calls above, `get_limits.py` just inspects
// nvidia-smi/torch.cuda directly (no model load, no shared FastAPI state),
// so it can't contend with a resident ACE-Step/comfy/ollama process — same
// reasoning `routes/ace/lyrics.routes.ts` documents for its CPU-only script.
// ---------------------------------------------------------------------------

const limitsRoute = defineRoute({
  method: 'GET',
  path: '/ace/training/limits',
  response: TrainingLimitsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Report GPU-tier generation limits (max duration/batch size)',
}, async ({ ok }) => {
  const result = await run('python3', [paths.aceGetLimitsScript], { timeoutMs: 15_000 });
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new UpstreamUnavailableError('Failed to read GPU limits', { stderr: result.stderr.slice(0, 2000) });
  }
  try {
    return ok(JSON.parse(result.stdout.trim()));
  } catch {
    throw new UpstreamUnavailableError('Failed to parse GPU limits output', { stdout: result.stdout.slice(0, 2000) });
  }
});

[
  transcribeUploadsRoute, buildDatasetRoute,
  preprocessRoute, preprocessStatusRoute,
  autoLabelRoute, autoLabelStatusRoute,
  transcribeUploadsStatusRoute,
  initModelRoute, checkpointsRoute, loraCheckpointsRoute,
  loadDatasetRoute, samplePreviewRoute, saveSampleRoute, updateSettingsRoute,
  startTrainingRoute, trainingStatusRoute, stopTrainingRoute,
  preprocessStemsRoute, preprocessStemsStatusRoute,
  limitsRoute,
].forEach((r) => r.register(router));

export default router;

// TODO(later agent): not ported from ace-step-ui's training.ts —
//   - `GET /audio` (raw arbitrary-path file proxy) and `POST /scan-directory`
//     (arbitrary directory scan): both assumed a checked-out ACE-Step source
//     tree as the sandbox root (`getAceStepDir()`); comfy has none, and
//     re-scoping either to an arbitrary user-supplied directory outside
//     comfy's own `paths.ace*` roots would be a real traversal/exfiltration
//     risk. `upload-audio` + `build-dataset` cover the actual upload flow.
//   - `POST /save-dataset` / `POST /load-tensors`: distinct-but-overlapping
//     with `build-dataset`/`load-dataset`/`preprocess` above; ace-step-ui's
//     UI didn't appear to call the former on the main happy path. Add if the
//     ported frontend needs a manual "save current dataset to a custom path"
//     or "load raw tensor dir without going through /preprocess" action.
//   - `POST /cleanup-artifacts`: disk-space-reclaim convenience (delete
//     checkpoints/logs/wandb/tensorboard under an output dir, preserving
//     `final/`). Useful but not required for the training flow to function;
//     add as a follow-up if disk usage becomes a problem.
//   - `POST /export`: `/v1/training/export` passthrough for a separate
//     "export LoRA to a custom path" step — the trained adapter is already
//     usable directly from `<outputDir>/final/adapter` via
//     `routes/ace/lora.routes.ts`'s `resolveAdapterPath`, so this is a
//     nice-to-have, not load-bearing.