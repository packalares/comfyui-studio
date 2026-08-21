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
import { NotFoundError, ValidationError, ConflictError, HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { submitGpuJob, scheduler, CancelledError as SchedulerCancelledError } from '../../services/gpu/scheduler.js';
import { getAceStepProcessService } from '../../services/aceStep/process.js';
import * as aceStep from '../../services/ace/acestep.js';
import * as storage from '../../services/ace/storage.js';
import * as audioSeparator from '../../services/ace/audioSeparator.js';
import { paths } from '../../config/paths.js';
import * as aceMusicRepo from '../../lib/db/aceMusic.repo.js';
import type { GalleryRow } from '../../lib/db/gallery.repo.js';
import { inspectFile } from '../../services/gallery/fileInspect.js';
import { broadcastAce } from '../../services/ace/broadcaster.js';
import { PACKS } from '../../services/packs/registry.js';
import { effectiveDest, effectiveRepo } from '../../services/packs/settings.js';
import { resolveEffectiveDitModel, resolveEffectiveLmModel, ensureAceStepModelLoaded } from '../../services/ace/modelSelection.js';
import { authMiddleware } from '../../middleware/auth.js';
import { generateLyrics } from './lyrics.routes.js';
import { ollamaChat, resolveSuggestionModel } from '../../services/ace/ollamaAssist.js';
import { SUGGESTION_SYSTEM_PROMPT } from '../../services/ace/prompts.js';
import { z } from 'zod';
import {
  toStatusView, broadcastJob, updateJobStatus, numeric, text,
} from './generationJobView.js';
import {
  GenerationParamsSchema,
  GenerateSubmitResponseSchema,
  GenerationStatusParamsSchema,
  GenerationStatusResponseSchema,
  ModelsListResponseSchema,
  SimpleGenerateBodySchema,
  SimpleGenerateResponseSchema,
  RandomDescriptionQuerySchema,
  RandomDescriptionResponseSchema,
  FormatBodySchema,
  FormatResponseSchema,
  UploadAudioResponseSchema,
  AudioParamsSchema,
  GpuStatusResponseSchema,
  AutoUnloadBodySchema,
  GenerationCancelParamsSchema,
  GenerationCancelResponseSchema,
  AnalyzeBodySchema,
  AnalyzeResponseSchema,
  StemsBodySchema,
  StemsResponseSchema,
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
/** Analysis is an encode + tokenize, not a diffusion run. Minutes here would
 *  only ever mean something is wedged, and the user is staring at a spinner
 *  in a drop zone — so fail fast rather than inherit generation's 25min. */
const ANALYZE_MAX_WAIT_MS = 3 * 60 * 1000;


// ---------------------------------------------------------------------------
// Cancellation
//
// ACE-Step 1.5's FastAPI has no cancel/abort/stop endpoint for a generation
// task (only `/v1/training/stop`, unrelated) — verified against both the
// documented endpoint list and the actual route registrations
// (`acestep/api/route_setup.py`). So once ACE-Step has accepted a task the
// GPU keeps computing it to completion regardless of what comfy's UI shows;
// cancellation here can only mean "comfy stops caring about the result":
// stop polling, release the GPU scheduler slot, mark the job cancelled, and
// best-effort `aceStep.cleanupTask` so ACE-Step's result cache doesn't linger.
//
// Mirrors `services/aiToolkit/train.ts`'s pattern: an AbortController per
// job, submitted as `submitGpuJob(..., controller.signal)`. QUEUED: the
// scheduler's own signal-wiring rejects with `SchedulerCancelledError`
// before `run()` is ever invoked — no GPU slot is occupied. RUNNING:
// `pollUntilTerminal` checks the signal every tick and throws
// `GenerationCancelledError`, caught inside `run()`'s own try/catch.
// ---------------------------------------------------------------------------

class GenerationCancelledError extends Error {
  constructor(jobId: string) {
    super(`Generation ${jobId} cancelled`);
    this.name = 'GenerationCancelledError';
  }
}

interface GenerationRuntimeState {
  controller: AbortController;
  cancelRequested: boolean;
}

// In-memory only — a restart loses the ability to cancel cleanly (same
// trade-off `ai_toolkit_jobs` documents); the DB row survives at its last
// status. Entries are removed as soon as a job reaches a terminal state.
const runtime = new Map<string, GenerationRuntimeState>();

export type GenerationCancelResult = 'cancelled' | 'not_found' | 'already_terminal';

/** Queued: aborts the scheduler wait (never occupies a GPU slot). Running:
 *  stops the poll loop + releases the GPU slot (see header comment above). */
function cancelGenerationJob(jobId: string): GenerationCancelResult {
  const job = aceMusicRepo.getGenerationJob(jobId);
  if (!job) return 'not_found';
  if (job.status !== 'queued' && job.status !== 'running') return 'already_terminal';

  const rt = runtime.get(jobId);
  if (!rt) {
    // Runtime state already gone (e.g. server restarted mid-job) — force the
    // DB row terminal so the UI isn't stuck waiting on a job nothing will
    // ever finish tracking.
    updateJobStatus(jobId, { status: 'cancelled', error: null });
    return 'cancelled';
  }
  rt.cancelRequested = true;
  rt.controller.abort();
  return 'cancelled';
}

async function pollUntilTerminal(
  taskId: string,
  jobId: string,
  signal: AbortSignal,
): Promise<aceStep.TaskQueryResult> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastTickJson = '';
  while (Date.now() < deadline) {
    if (signal.aborted) throw new GenerationCancelledError(jobId);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (signal.aborted) throw new GenerationCancelledError(jobId);
    const status = await aceStep.queryTask(taskId).catch(() => null);
    if (!status) continue;
    if (status.completed || status.failed) return status;
    // Intermediate tick — this loop already polls ACE-Step every 2s to hold
    // the GPU slot open; piggyback a WS push here so the client doesn't also
    // need to poll `GET /status/:jobId` to watch progress climb. Dedup on
    // the serialised view so an unchanged tick (ACE-Step reports the exact
    // same progress/stage twice in a row) doesn't spam an extra frame.
    const job = aceMusicRepo.getGenerationJob(jobId);
    if (job) {
      const view = toStatusView(job, { progress: status.progress, stage: status.stage });
      const json = JSON.stringify(view);
      if (json !== lastTickJson) {
        lastTickJson = json;
        broadcastAce('ace:generation', view);
      }
    }
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
 *  `gallery` row (the single source of truth the file exists) + `ace_songs`
 *  sidecar row — in the same transaction — per variation (batchSize > 1 =>
 *  multiple files). No promptId: this audio never went through a ComfyUI
 *  prompt. */
async function persistGeneratedSongs(
  jobId: string,
  params: GenerationParamsInput,
  status: aceStep.TaskQueryResult,
): Promise<{ audioUrls: string[]; measuredDurationSec: number | null }> {
  const ext = audioExtFor(params.audioFormat);
  const audioUrls: string[] = [];
  // ffprobe-measured length of the first rendered file. ACE-Step reports "N/A"
  // for duration on cover/repaint, and falling back to the REQUESTED duration
  // is actively wrong there: a cover re-records the source track, so its length
  // is the SOURCE's length, not what was asked for. Requesting 240s from a 19s
  // source yields 19s of audio and we would have stored "240".
  let measuredDurationSec: number | null = null;
  const variationCount = status.audioFileUrls.length;

  for (let i = 0; i < variationCount; i += 1) {
    const songId = randomUUID();
    const variationSuffix = variationCount > 1 ? ` (v${i + 1})` : '';
    const title = autoTitle(params) + variationSuffix;
    try {
      const buffer = await aceStep.downloadAudioToBuffer(status.audioFileUrls[i]);
      const stored = await storage.saveGeneratedAudioToOutput(songId, i, buffer, ext);
      const inspection = await inspectFile(stored.absPath);
      const galleryRow: GalleryRow = {
        id: randomUUID(),
        filename: stored.filename,
        subfolder: stored.subfolder,
        type: 'output',
        mediaType: 'audio',
        url: stored.url,
        promptId: '', // matches disk-sweep's convention for a promptId-less row
        createdAt: Date.now() - i,
        triggeredBy: 'ui',
        sizeBytes: inspection?.sizeBytes ?? null,
        mediaDurationMs: inspection?.mediaDurationMs ?? null,
        mediaInfoJson: inspection?.mediaInfo != null ? JSON.stringify(inspection.mediaInfo) : null,
      };
      aceMusicRepo.insertSong({
        id: songId,
        galleryRow,
        title,
        lyrics: params.instrumental ? '[Instrumental]' : params.lyrics,
        style: params.style,
        caption: params.style,
        // Same "N/A" sentinel as the job result (see `numeric`/`text` in
        // generationJobView.ts): ACE-Step returns the STRING "N/A" for these on
        // cover/repaint jobs, which SQLite happily stores in an INTEGER column
        // and which then fails `SongSchema` on every subsequent read.
        bpm: numeric(status.bpm) ?? numeric(params.bpm) ?? null,
        keyScale: text(status.keyScale) ?? text(params.keyScale) ?? null,
        timeSignature: text(status.timeSignature) ?? text(params.timeSignature) ?? null,
        tags: [],
        generationParams: params,
        generationJobId: jobId,
      });
      audioUrls.push(galleryRow.url ?? '');
      if (measuredDurationSec === null && inspection?.mediaDurationMs != null) {
        measuredDurationSec = Math.round(inspection.mediaDurationMs / 1000);
      }
    } catch {
      // Best-effort per-file: one bad download shouldn't sink the whole batch.
    }
  }
  return { audioUrls, measuredDurationSec };
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

  // Registered before the job row is even broadcast so a client that reacts
  // to the WS 'queued' push instantly (see `broadcastJob` below) can never
  // race `POST /ace/generate/cancel/:jobId` ahead of this entry existing.
  const controller = new AbortController();
  runtime.set(jobId, { controller, cancelRequested: false });

  const inserted = aceMusicRepo.insertGenerationJob(jobId, body);
  broadcastJob(inserted);
  type SubmitOutcome = { jobId: string; status: 'queued' | 'running'; taskId: string | null };
  let resolveRoute!: (v: SubmitOutcome | Promise<SubmitOutcome>) => void;
  const routePromise = new Promise<SubmitOutcome>((r) => { resolveRoute = r; });
  // Kick off the scheduler job. Do NOT await — the slot stays held while the
  // callback keeps polling. The route awaits routePromise instead, which
  // resolves the moment ACE-Step accepts the task.
  void submitGpuJob('ace-step-generate', async (release) => {
    let taskId: string | null = null;
    try {
      await ensureAceStepModelLoaded(resolveEffectiveDitModel(body.ditModel), resolveEffectiveLmModel());
      const submitted = await aceStep.submitGeneration(body, resolveLocalUrl);
      taskId = submitted.taskId;
      updateJobStatus(jobId, { status: 'running', acestepTaskId: taskId });
      resolveRoute({ jobId, status: 'running', taskId });

      const finalStatus = await pollUntilTerminal(taskId, jobId, controller.signal);
      if (finalStatus.failed) {
        updateJobStatus(jobId, { status: 'failed', error: finalStatus.error ?? 'Generation failed' });
        return;
      }
      const { audioUrls, measuredDurationSec } = await persistGeneratedSongs(jobId, body, finalStatus);
      if (audioUrls.length === 0) {
        updateJobStatus(jobId, { status: 'failed', error: 'ACE-Step returned no audio files' });
        return;
      }
      updateJobStatus(jobId, {
        status: 'succeeded',
        result: {
          audioUrls,
          // Measured first: it's the only value that describes the file that
          // actually exists. ACE-Step's own number, then the request, are
          // fallbacks for when ffprobe couldn't read it.
          duration: measuredDurationSec ?? numeric(finalStatus.duration) ?? numeric(body.duration) ?? 0,
          bpm: numeric(finalStatus.bpm) ?? numeric(body.bpm),
          keyScale: text(finalStatus.keyScale) ?? text(body.keyScale),
          timeSignature: text(finalStatus.timeSignature) ?? text(body.timeSignature),
          status: 'succeeded',
        },
      });
      aceStep.cleanupTask(taskId);
    } catch (err) {
      if (err instanceof GenerationCancelledError) {
        // ACE-Step has no cancel/abort endpoint (see the header comment
        // above `pollUntilTerminal`) — the GPU keeps computing the job to
        // completion regardless. This only stops comfy from waiting on it.
        updateJobStatus(jobId, { status: 'cancelled', error: null });
        if (taskId) aceStep.cleanupTask(taskId);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      updateJobStatus(jobId, { status: 'failed', error: message });
      resolveRoute(Promise.reject(err));
    } finally {
      release();
      runtime.delete(jobId);
    }
  }, controller.signal).catch((err) => {
    // Reaching here with the route still pending means submitGpuJob rejected
    // BEFORE run() was ever invoked — cancelled while queued (the scheduler's
    // own signal-wiring rejects with SchedulerCancelledError), or
    // ensureResident() itself threw (it calls unloadComfy() -> waitForComfyIdle(),
    // which can block for minutes, and startAceStep()). run()'s own catch never
    // fired, so nothing has resolved routePromise and nothing has written the
    // job row. Without this the HTTP request hangs forever.
    // (services/aiToolkit/train.ts handles the same case the same way.)
    runtime.delete(jobId);
    if (err instanceof SchedulerCancelledError) {
      const job = aceMusicRepo.getGenerationJob(jobId);
      if (job && job.status === 'queued') updateJobStatus(jobId, { status: 'cancelled', error: null });
      resolveRoute(Promise.reject(new Error('Generation cancelled')));
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const job = aceMusicRepo.getGenerationJob(jobId);
    if (job && (job.status === 'queued' || job.status === 'running')) {
      updateJobStatus(jobId, { status: 'failed', error: message });
    }
    resolveRoute(Promise.reject(err instanceof Error ? err : new Error(message)));
  });

  const result = await routePromise;
  return ok(result);
});

// ---------------------------------------------------------------------------
// POST /ace/generate/cancel/:jobId — cancel a queued or running job
// ---------------------------------------------------------------------------

const cancelRoute = defineRoute({
  method: 'POST',
  path: '/ace/generate/cancel/:jobId',
  params: GenerationCancelParamsSchema,
  response: GenerationCancelResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Cancel a queued or running ACE-Step generation job',
}, ({ params, ok }) => {
  const result = cancelGenerationJob(params.jobId);
  if (result === 'not_found') throw new NotFoundError('Job not found');
  if (result === 'already_terminal') throw new ConflictError('Job already finished');
  return ok({ jobId: params.jobId, cancelled: true });
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

  return ok(toStatusView(job, { progress, stage }));
});

// ---------------------------------------------------------------------------
// GET /ace/generate/models — DiT model list (installed pack checkpoints + active model)
// ---------------------------------------------------------------------------


/** Read a checkpoint's own `config.json` `is_turbo` flag — the value ACE-Step
 *  itself gates task types on. Returns null when the file is absent or
 *  unparseable (model not downloaded yet, partial download, unexpected
 *  layout); callers treat null as "assume turbo", which hides the base-only
 *  modes rather than offering ones that would fail inside ACE-Step. */
function readIsTurbo(checkpointDir: string): boolean | null {
  try {
    const raw = fs.readFileSync(path.join(checkpointDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { is_turbo?: unknown };
    return typeof parsed.is_turbo === 'boolean' ? parsed.is_turbo : null;
  } catch {
    return null;
  }
}

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
  // path — that's how comfy's pack installer lays these out on disk. `kind`
  // (not a path-string match) is the source of truth for which entries are
  // checkpoints; the actual dest is resolved through the same
  // repo-override-aware helper the installer itself uses
  // (`services/packs/settings.ts`) so a corrected repo_override is reflected
  // here too.
  const checkpointModels = PACKS['ace-step'].models.filter((m) => m.kind === 'checkpoint');

  let activeModel: string | null = null;
  try {
    const inventory = await aceStep.getModelInventory();
    activeModel = inventory.find((m) => m.is_loaded)?.name ?? null;
  } catch {
    // ACE-Step API unavailable — fall through with no active model.
  }

  const models = checkpointModels.map((m) => {
    const dest = effectiveDest('ace-step', m.id, m.kind, effectiveRepo('ace-step', m.id, m.repo));
    const name = path.basename(dest);
    return {
      name,
      is_active: name === activeModel,
      is_preloaded: fs.existsSync(dest) && fs.statSync(dest).isDirectory(),
      is_default: m.default === true,
      is_turbo: readIsTurbo(dest),
    };
  });

  // `is_default` ranks above alphabetical. Without it every checkpoint is
  // equally "preloaded" once downloaded, so ordering fell through to the name
  // and `acestep-v15-xl-base` sorted first (base < sft < turbo). The client
  // preselects the head of this list, so the effective default became the base
  // checkpoint — a fine-tuning starting point, not a generation model. That
  // went unnoticed while `switchModel()` was dead code (ACE-Step just used
  // whatever it booted with, a turbo model); once selection was actually
  // applied, every generation silently switched to base and sounded worse.
  // `is_default` now outranks `is_active`, matching the client's own
  // preselection. Ranking the *currently resident* checkpoint first meant a
  // model loaded for some incidental reason (an analysis call, a previous
  // experiment) presented itself as the natural choice, which is how base and
  // SFT kept becoming the effective generation model without anyone picking
  // them. Residency is a performance detail; it should not look like intent.
  models.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
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
    try {
      const generated = await generateLyrics({
        genre: body.genre,
        topic: caption,
        language: language === 'unknown' ? 'english' : language,
      });
      lyrics = generated ?? '';
    } catch {
      // Best-effort: e.g. the ace-step pack's `main` venv (which
      // llama-cpp-python lives in) isn't installed yet. Degrade to no
      // lyrics rather than failing the whole Simple-mode request.
      lyrics = '';
    }
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

/**
 * Absolute-last-resort prompt suggestions — used only when Ollama itself is
 * unreachable / has no models installed (see `ollamaSuggestion` below).
 *
 * ACE-Step's own `/create_random_sample` would be nicer (it samples from the
 * training-caption distribution), but it requires the FastAPI child to be
 * running, and that only happens once a GPU job takes the `ace-step` tenant.
 * Asking the user to wait for a multi-GB model load just to fill a text box
 * is the wrong trade — Ollama covers that cold case instead (small/fast
 * model, no ACE-Step involved), and this hardcoded pool is the fallback for
 * when even Ollama isn't available.
 */
const FALLBACK_SAMPLES: { description: string; instrumental: boolean; vocalLanguage: string }[] = [
  { description: 'upbeat synth-pop with bright arpeggios and a soaring female chorus', instrumental: false, vocalLanguage: 'en' },
  { description: 'dreamy lo-fi hip hop, warm vinyl crackle, mellow rhodes chords', instrumental: true, vocalLanguage: 'unknown' },
  { description: 'driving indie rock, jangly guitars, anthemic male vocals', instrumental: false, vocalLanguage: 'en' },
  { description: 'cinematic orchestral build with strings and taiko percussion', instrumental: true, vocalLanguage: 'unknown' },
  { description: 'smooth neo-soul groove, electric piano, breathy vocal harmonies', instrumental: false, vocalLanguage: 'en' },
  { description: 'dark techno, relentless four-on-the-floor kick, acid bassline', instrumental: true, vocalLanguage: 'unknown' },
  { description: 'acoustic folk ballad, fingerpicked guitar, intimate storytelling vocal', instrumental: false, vocalLanguage: 'en' },
];

function localFallbackSample(lang?: string): { description: string; instrumental: boolean; vocalLanguage: string } {
  const pool = lang
    ? FALLBACK_SAMPLES.filter((s) => s.vocalLanguage === lang || s.vocalLanguage === 'unknown')
    : FALLBACK_SAMPLES;
  const from = pool.length > 0 ? pool : FALLBACK_SAMPLES;
  const pick = from[Math.floor(Math.random() * from.length)];
  return lang ? { ...pick, vocalLanguage: lang } : pick;
}



/**
 * Ask Ollama for a one-line Simple-mode song idea — the cold-case
 * replacement for ACE-Step's own `/create_random_sample` (see
 * `FALLBACK_SAMPLES`'s doc comment). Returns `null` (never throws) when no
 * Ollama model is configured/installed or the completion fails, so the
 * caller can degrade to `localFallbackSample`.
 */
async function ollamaSuggestion(
  lang?: string,
): Promise<{ description: string; instrumental: boolean; vocalLanguage: string } | null> {
  const model = await resolveSuggestionModel();
  if (!model) return null;

  const userPrompt = lang
    ? `Suggest a random, creative one-line song idea. If it has vocals, they should be sung in: ${lang}.`
    : 'Suggest a random, creative one-line song idea.';
  const content = await ollamaChat(model, SUGGESTION_SYSTEM_PROMPT, userPrompt, { temperature: 1.0, maxTokens: 200 });
  if (!content) return null;

  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}') + 1;
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(content.slice(start, end)) as {
        description?: unknown; instrumental?: unknown; vocalLanguage?: unknown;
      };
      const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
      if (description) {
        return {
          description,
          instrumental: Boolean(parsed.instrumental),
          vocalLanguage: typeof parsed.vocalLanguage === 'string' && parsed.vocalLanguage
            ? parsed.vocalLanguage
            : (lang ?? 'unknown'),
        };
      }
    }
  } catch {
    // Fall through — treat the raw content as the description itself.
  }
  return { description: content.replace(/\s+/g, ' ').trim(), instrumental: false, vocalLanguage: lang ?? 'en' };
}

const randomDescriptionRoute = defineRoute({
  method: 'GET',
  path: '/ace/generate/random-description',
  query: RandomDescriptionQuerySchema,
  response: RandomDescriptionResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Fetch a random Simple-mode song idea from Ollama',
}, async ({ query, ok }) => {
  const suggestion = await ollamaSuggestion(query.lang);
  if (suggestion) return ok(suggestion);
  // Ollama unreachable / no model installed — degrade to the local pool.
  // ACE-Step is never started just to fill a text box.
  return ok(localFallbackSample(query.lang));
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
  // Runs through the GPU scheduler rather than calling ACE-Step directly.
  //
  // `/format_input` is served by ACE-Step's own LM, so it needs the backend
  // process up and the `ace-step` tenant resident — exactly what
  // `submitGpuJob` -> `ensureResident` guarantees. Calling it directly (the
  // previous behaviour) meant clicking Enhance while the backend was stopped
  // — including after the idle-evict timer fired, which is the common case —
  // failed with a raw "ACE-Step API unreachable: /format_input" instead of
  // just starting it.
  //
  // Queuing also makes Enhance behave like every other GPU consumer: it waits
  // its turn behind a running generation rather than racing it for VRAM.
  // Unlike `submitRoute` this awaits the whole job — the formatter returns in
  // seconds, so there's no reason to hand back a task id and poll.
  const result = await submitGpuJob('ace-step-format', async (release) => {
    try {
      return await aceStep.formatInput(body);
    } finally {
      release();
    }
  });
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
// GPU residency / idle-unload — GET /ace/generate/gpu/status,
// POST /ace/generate/gpu/auto-unload.
//
// ACE-Step is a resident GPU tenant (`services/gpu/residency.ts`): once a
// generation job takes the `ace-step` tenant, comfy's scheduler holds it
// resident (~19 GB VRAM) until ANOTHER tenant demands the GPU — there was no
// idle timeout of its own, so a user who stops generating keeps that VRAM
// squatted indefinitely. `services/gpu/scheduler.ts`'s `armIdleEvictIfNeeded`
// now covers `ace-step` the same way it already covered `ollama`, just with
// a much longer default (`ACE_STEP_IDLE_EVICT_MS` — ACE-Step's cold start
// reloads the full checkpoint, so evicting too eagerly is worse than
// holding). These two routes restore the control surface ace-step-ui had
// (`POST /api/generate/gpu/auto-unload`, `GET /api/generate/gpu/status`)
// that this port dropped — a runtime override of that timeout, and a status
// view the UI can show (running? idle minutes? configured timeout?).
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;

function gpuStatusView(): z.infer<typeof GpuStatusResponseSchema> {
  const idle = scheduler.getIdleStatus('ace-step');
  return {
    running: getAceStepProcessService().getPid() !== null,
    tenant: idle.tenant,
    idleMinutes: idle.idleMs !== null ? Math.floor(idle.idleMs / MINUTE_MS) : null,
    timeoutMinutes: idle.timeoutMs !== null ? Math.round(idle.timeoutMs / MINUTE_MS) : null,
  };
}

const gpuStatusRoute = defineRoute({
  method: 'GET',
  path: '/ace/generate/gpu/status',
  response: GpuStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'ACE-Step GPU residency status (running? idle minutes? configured idle-unload timeout?)',
}, ({ ok }) => ok(gpuStatusView()));

const autoUnloadRoute = defineRoute({
  method: 'POST',
  path: '/ace/generate/gpu/auto-unload',
  body: AutoUnloadBodySchema,
  response: GpuStatusResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Set (or clear) the ACE-Step idle-unload timeout, in minutes',
}, ({ body, ok }) => {
  const ms = body.minutes == null ? null : body.minutes * MINUTE_MS;
  scheduler.setIdleEvictOverrideMs('ace-step', ms);
  return ok(gpuStatusView());
});

// ---------------------------------------------------------------------------
// GET /ace/audio/:kind/:key — stream stored reference/source audio (a
// user upload for cover/audio2audio). Generated song audio is served
// through the gallery's `/api/view` now (see migration 0009) — this route
// only ever handles kind='reference'. Mirrors `routes/view.routes.ts`: no
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
  summary: 'Stream stored ACE-Step reference/source audio',
});

router.get('/ace/audio/:kind/:key', (req: Request, res: Response) => {
  const { kind, key } = req.params;
  if (typeof key !== 'string' || kind !== 'reference') {
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

/**
 * POST /ace/analyze — capture a track's style as ACE-Step audio codes.
 *
 * Runs the same `/release_task` -> `/query_result` cycle as generation, but
 * with `extract_codes_only`, so ACE-Step encodes the source and returns its
 * semantic tokens instead of synthesising audio. Awaited inline rather than
 * tracked as a job row: it produces no song, and skipping the DB round-trip
 * keeps the "drop a track, see the style captured" interaction immediate.
 *
 * Still goes through `submitGpuJob` — it needs the DiT resident exactly like a
 * generation does, and bypassing the scheduler would let it collide with a
 * running job for the GPU.
 */
const analyzeRoute = defineRoute({
  method: 'POST',
  path: '/ace/analyze',
  body: AnalyzeBodySchema,
  response: AnalyzeResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Extract ACE-Step audio codes (style fingerprint) from a track',
}, async ({ body, ok }) => {
  const controller = new AbortController();

  /** One analysis round-trip. `deep` adds the LM pass that names the track. */
  const runAnalysis = async (deep: boolean): Promise<aceStep.TaskQueryResult> => {
    const { taskId } = await aceStep.submitGeneration({
      extractCodesOnly: !deep,
      fullAnalysisOnly: deep,
      sourceAudioUrl: body.sourceAudioUrl,
      ditModel: body.ditModel,
      // `task_type` is irrelevant on the analysis path — upstream branches on
      // the analysis flags before it ever looks at the task type — but the
      // request model still wants a valid one.
      taskType: 'text2music',
      // Required by GenerationParams, unused by the analysis branch: nothing
      // downstream reads caption/lyrics here.
      customMode: true,
      style: '',
      lyrics: '',
      title: '',
      instrumental: false,
    }, resolveLocalUrl);

    const deadline = Date.now() + ANALYZE_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const status = await aceStep.queryTask(taskId).catch(() => null);
      if (!status) continue;
      if (status.failed) throw new HttpError('upstream_unavailable', status.error || 'Analysis failed');
      if (status.completed) {
        aceStep.cleanupTask(taskId);
        // A completed analysis with no codes means upstream took a branch we
        // didn't expect. Failing loudly beats returning "" and letting the UI
        // show a captured style that would silently do nothing.
        if (!status.audioCodes) {
          throw new HttpError('upstream_unavailable', 'Analysis completed but returned no audio codes');
        }
        return status;
      }
    }
    throw new HttpError('upstream_unavailable', 'Analysis timed out');
  };

  const status = await submitGpuJob('ace-step-generate', async (release) => {
    try {
      await ensureAceStepModelLoaded(resolveEffectiveDitModel(body.ditModel), resolveEffectiveLmModel());
      // Deep first, shallow as a fallback. The deep pass needs the LM handler
      // resident and upstream raises if its understanding step returns nothing
      // — but the codes alone are what actually drive style transfer, so a
      // failed readout must not cost the user the feature. Degrading to
      // codes-only loses the description and keeps the capability.
      try {
        return await runAnalysis(true);
      } catch (err) {
        logger.warn('ace analyze: deep pass failed, falling back to codes-only', {
          message: err instanceof Error ? err.message : String(err),
        });
        return await runAnalysis(false);
      }
    } finally {
      release();
    }
  }, controller.signal);

  const codes = status.audioCodes ?? '';
  // Each token is one `<|audio_code_N|>`; counting them is how the UI tells a
  // real capture from an encode of near-silence.
  const codeCount = (codes.match(/<\|audio_code_/g) || []).length;
  return ok({
    audioCodes: codes,
    codeCount,
    bpm: status.bpm,
    keyScale: status.keyScale,
    timeSignature: status.timeSignature,
    duration: status.duration,
    genre: status.analysis?.genre,
    caption: status.analysis?.caption,
    lyrics: status.analysis?.lyrics,
    language: status.analysis?.language,
  });
});

/**
 * POST /ace/stems — split a track into real instrument stems.
 *
 * This is the separator (`services/ace/audioSeparator.ts`, Roformer/Demucs),
 * which already powered voice-clone training prep but had no route of its own
 * — so the capability existed with no way for anyone to use it. It is NOT
 * ACE-Step's `extract` task: this isolates what is actually in the recording,
 * whereas `extract` asks the model to re-synthesise an approximation. When
 * someone wants "the drums from this song", this is the one they mean.
 *
 * Scheduled as `ace-stem-separate` (tenant `oneshot`), the same task type the
 * training path uses, so it evicts ACE-Step rather than fighting it for VRAM.
 */
const stemsRoute = defineRoute({
  method: 'POST',
  path: '/ace/stems',
  body: StemsBodySchema,
  response: StemsResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Separate a track into instrument stems',
}, async ({ body, ok }) => {
  const inputPath = aceStep.resolveReferenceAudioPath(body.sourceAudioUrl, resolveLocalUrl);
  if (!inputPath) throw new ValidationError('Could not resolve the source track');

  const controller = new AbortController();
  const stems = await submitGpuJob('ace-stem-separate', async (release) => {
    try {
      const outputDir = path.join(paths.aceDatasetsDir, '.stem-scratch', `stems-${randomUUID()}`);
      const result = await aceStep_separate(inputPath, outputDir, body.model);
      // Copy out of the scratch dir into the output tree so the files survive
      // and become pickable; then drop the scratch dir.
      const baseName = path.basename(inputPath, path.extname(inputPath));
      const saved: { name: string; url: string }[] = [];
      for (const stem of result) {
        const buf = await fs.promises.readFile(stem.path);
        const out = await storage.saveStemAudio(baseName, stem.name, buf, path.extname(stem.path));
        saved.push({ name: stem.name, url: out.url });
      }
      await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
      return saved;
    } finally {
      release();
    }
  }, controller.signal);

  if (stems.length === 0) {
    throw new HttpError('upstream_unavailable', 'Separation produced no stems');
  }
  return ok({ stems });
});

/** Thin wrapper so the route body stays readable. Defaults to the 6-stem
 *  Demucs model — the 2-stem Roformer used for voice-clone prep only yields
 *  vocals/instrumental, which is not what "give me the drums" means. */
async function aceStep_separate(
  inputPath: string,
  outputDir: string,
  model?: string,
): Promise<{ name: string; path: string }[]> {
  const result = await audioSeparator.separateStems({
    inputPaths: [inputPath],
    outputDir,
    model: model || 'htdemucs_6s.yaml',
  });
  return result.outputs.flatMap((o) => o.stems);
}

[submitRoute, statusRoute, cancelRoute, modelsRoute, simpleRoute, randomDescriptionRoute, formatRoute, gpuStatusRoute, autoUnloadRoute, analyzeRoute, stemsRoute]
  .forEach((r) => r.register(router));

export default router;

// TODO(later agent): model download/switch (`POST /models/download`,
// `POST /models/switch`) from ace-step-ui's generate.ts are intentionally
// not ported — model installs go through comfy's capability-pack subsystem
// (`services/packs/*`) instead, so those routes would just be a duplicate
// control surface. (The GPU unload/status routes ARE ported now — see
// `gpuStatusRoute`/`autoUnloadRoute` above, backed by `services/gpu/
// scheduler.ts`'s idle-evict mechanism rather than ace-step-ui's ad-hoc
// `setTimeout`.) extract-codes / full-analysis (source-audio code
// extraction + metadata analysis for cover mode) are also deferred — same
// `/release_task` + `/query_result` polling shape as the main submit route,
// but a distinct feature; add as its own route if cover mode needs it
// before the training/LoRA agent lands.
