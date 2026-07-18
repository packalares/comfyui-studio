// Image-LoRA training orchestration: builds an ai-toolkit config, spawns
// `run.py` inside the GPU scheduler's `image-lora-train` slot (whole-card,
// see `services/gpu/taskTypes.ts` — `oneshot` tenant, `residency.ts` evicts
// ollama/comfy/ace-step first), streams progress into a per-job `LogService`
// ring buffer, and — on success — copies the finished LoRA into ComfyUI's
// `models/loras/` directory so comfy's own image generation can use it
// immediately.
//
// Unlike `routes/ace/training.routes.ts` (which proxies a long-running
// FastAPI process and treats its own DB table as a history/audit record —
// see that file's header comment), ai-toolkit training is a plain
// short-lived-per-call Python subprocess with no server of its own. This
// module — and the `ai_toolkit_jobs` table it writes to — IS the source of
// truth for job status.
//
// `child_process.spawn` is used directly (never `lib/exec.ts`'s `run`,
// which buffers stdout/stderr until the process exits) so training progress
// can stream into the log/DB live. `shell: false` is passed explicitly,
// matching `lib/exec.ts`'s "argv-only, no shell" contract — this exact
// precedent (raw spawn for a long streaming subprocess, `run()` reserved for
// short buffered ones) is already established by
// `services/ace/audioSeparator.ts` and `services/comfyui/process.ts`.

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { currentProcessEnv, env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { submitGpuJob } from '../gpu/scheduler.js';
import { LogService } from '../comfyui/process.js';
import * as repo from '../../lib/db/aiToolkit.repo.js';
import type { AiToolkitJobRow } from '../../lib/db/aiToolkit.repo.js';
import { AI_TOOLKIT_DIR } from '../packs/registry.js';
import { resolveBaseModelPath } from './baseModels.js';
import { resolveComfyLorasDir } from './lorasDir.js';
import { countImages, datasetDir } from './datasets.js';
import { sanitizeIdentifier } from './util.js';
import {
  writeAiToolkitConfig, resolveTrainedLoraPath, type AiToolkitArch,
} from './config.js';

function python(): string {
  return env.PYTHON_PATH || 'python3';
}

export interface StartTrainingInput {
  name: string;
  baseModel: string;
  arch: AiToolkitArch;
  datasetName: string;
  triggerWord?: string;
  steps: number;
  learningRate: number;
  rank: number;
  alpha?: number;
  batchSize: number;
  resolution: number;
  saveEvery: number;
  seed?: number;
  lowVram?: boolean;
}

interface RuntimeState {
  controller: AbortController;
  child: ChildProcess | null;
  log: LogService;
  cancelRequested: boolean;
}

// In-memory only — a server restart loses live log tail + the ability to
// cancel an in-flight run cleanly (mirrors ace-step-ui's original in-memory
// job maps; the DB row itself survives and is left at its last-known status,
// same trade-off `ace_training_runs` documents).
const runtime = new Map<string, RuntimeState>();

const RUNTIME_TTL_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 10_000;

// tqdm's default bar format: "<desc>:  42%|████      | 840/2000 [..., postfix]"
// (see `config.ts`'s header comment — `ToolkitProgressBar` is a plain tqdm
// subclass with no bar_format override). Matched anywhere in the line so it
// doesn't depend on the exact desc text.
const PROGRESS_RE = /(\d+)%\|[^|]*\|\s*(\d+)\/(\d+)/;

function ensureAiToolkitInstalled(): void {
  const runScript = path.join(AI_TOOLKIT_DIR, 'run.py');
  if (!fs.existsSync(runScript)) {
    throw new ConflictError('The ai-toolkit capability pack is not installed yet — install it from Packs first');
  }
}

/** Spawns `run.py <configPath>`, streams stdout/stderr into `log`, and
 *  parses tqdm progress lines to keep the DB row's step/progress live. */
function runAiToolkitProcess(jobId: string, configPath: string, log: LogService): Promise<void> {
  return new Promise((resolve, reject) => {
    const runScript = path.join(AI_TOOLKIT_DIR, 'run.py');
    const child = spawn(python(), [runScript, configPath], {
      cwd: AI_TOOLKIT_DIR,
      env: currentProcessEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const rt = runtime.get(jobId);
    if (rt) rt.child = child;

    let lastStep = -1;
    const pumpLine = (line: string) => {
      if (!line) return;
      log.addLog(line);
      const m = PROGRESS_RE.exec(line);
      if (!m) return;
      const step = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      if (!Number.isFinite(step) || step === lastStep) return;
      lastStep = step;
      const progress = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;
      repo.updateAiToolkitJob(jobId, {
        step,
        ...(total > 0 ? { totalSteps: total } : {}),
        progress,
      });
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8');
      let idx: number;
      // tqdm uses \r for in-place updates; split on either.
      while ((idx = stdoutBuf.search(/[\r\n]/)) >= 0) {
        pumpLine(stdoutBuf.slice(0, idx));
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
      let idx: number;
      while ((idx = stderrBuf.search(/[\r\n]/)) >= 0) {
        pumpLine(stderrBuf.slice(0, idx));
        stderrBuf = stderrBuf.slice(idx + 1);
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      if (stdoutBuf) pumpLine(stdoutBuf);
      if (stderrBuf) pumpLine(stderrBuf);
      if (rt) rt.child = null;
      if (code === 0) { resolve(); return; }
      reject(new Error(`run.py exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`));
    });
  });
}

/** Copy the trained LoRA into ComfyUI's loras dir. Never overwrites an
 *  existing file with the same name — appends a short suffix instead, so a
 *  re-run under the same job name can never clobber someone else's LoRA. */
function installLoraIntoComfy(sourcePath: string, jobName: string): string {
  const lorasDir = resolveComfyLorasDir();
  fs.mkdirSync(lorasDir, { recursive: true, mode: 0o755 });
  let filename = `${jobName}.safetensors`;
  let dest = path.join(lorasDir, filename);
  if (fs.existsSync(dest)) {
    filename = `${jobName}-${Date.now()}.safetensors`;
    dest = path.join(lorasDir, filename);
  }
  fs.copyFileSync(sourcePath, dest);
  return dest;
}

function validateInput(input: StartTrainingInput): void {
  if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100_000) {
    throw new ValidationError('steps must be an integer between 1 and 100000');
  }
  if (!(input.learningRate > 0) || input.learningRate > 1) {
    throw new ValidationError('learningRate must be a positive number <= 1');
  }
  if (!Number.isInteger(input.rank) || input.rank < 1 || input.rank > 512) {
    throw new ValidationError('rank must be an integer between 1 and 512');
  }
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 64) {
    throw new ValidationError('batchSize must be an integer between 1 and 64');
  }
  if (!Number.isInteger(input.resolution) || input.resolution < 64 || input.resolution > 2048) {
    throw new ValidationError('resolution must be an integer between 64 and 2048');
  }
  if (!Number.isInteger(input.saveEvery) || input.saveEvery < 1 || input.saveEvery > input.steps) {
    throw new ValidationError('saveEvery must be a positive integer no greater than steps');
  }
}

/** Kick off a training run. Returns immediately with the jobId; the actual
 *  run happens in the background once the GPU scheduler grants the
 *  `image-lora-train` slot (see `services/gpu/taskTypes.ts`). */
export function startTrainingJob(input: StartTrainingInput): { jobId: string } {
  ensureAiToolkitInstalled();
  validateInput(input);

  const displayName = sanitizeIdentifier(input.name, 'lora');
  const datasetName = sanitizeIdentifier(input.datasetName);
  const dsDir = datasetDir(datasetName);
  if (!fs.existsSync(dsDir)) throw new NotFoundError(`Dataset not found: ${datasetName}`);
  if (countImages(dsDir) === 0) throw new ValidationError('Dataset has no images');

  const baseModelPath = resolveBaseModelPath(input.baseModel);

  const jobId = randomUUID();
  // Job-name-on-disk includes a jobId slice so two runs sharing a display
  // name never collide under the same `training_folder/<name>/` save root.
  const configJobName = `${displayName}_${jobId.slice(0, 8)}`;

  const configInput = {
    jobName: configJobName,
    baseModelPath,
    arch: input.arch,
    datasetDir: dsDir,
    trainingFolder: paths.aiToolkitOutputDir,
    triggerWord: input.triggerWord?.trim() || undefined,
    steps: input.steps,
    learningRate: input.learningRate,
    rank: input.rank,
    alpha: input.alpha,
    batchSize: input.batchSize,
    resolution: input.resolution,
    saveEvery: input.saveEvery,
    seed: input.seed,
    lowVram: input.lowVram,
  };
  const configPath = writeAiToolkitConfig(paths.aiToolkitConfigsDir, jobId, configInput);

  repo.insertAiToolkitJob({
    id: jobId,
    name: displayName,
    baseModel: input.baseModel,
    datasetPath: dsDir,
    config: { ...configInput, configPath },
  });
  repo.updateAiToolkitJob(jobId, { totalSteps: input.steps });

  const controller = new AbortController();
  const log = new LogService();
  runtime.set(jobId, { controller, child: null, log, cancelRequested: false });
  log.addLog(`Queued training job "${displayName}" (config: ${configJobName})`);

  void submitGpuJob('image-lora-train', async (release) => {
    try {
      repo.updateAiToolkitJob(jobId, { status: 'running', startedAt: Date.now() });
      log.addLog('GPU slot granted — starting run.py');
      await runAiToolkitProcess(jobId, configPath, log);

      const loraPath = resolveTrainedLoraPath(paths.aiToolkitOutputDir, configJobName);
      if (!loraPath) throw new Error('Training finished but no LoRA output file was found on disk');
      const installedPath = installLoraIntoComfy(loraPath, configJobName);
      log.addLog(`LoRA installed into ComfyUI loras dir: ${path.basename(installedPath)}`);
      repo.updateAiToolkitJob(jobId, {
        status: 'succeeded', progress: 100, outputPath: installedPath, finishedAt: Date.now(),
      });
    } catch (err) {
      const rt = runtime.get(jobId);
      const cancelled = rt?.cancelRequested === true;
      const message = err instanceof Error ? err.message : String(err);
      log.addLog(`Training ${cancelled ? 'cancelled' : 'failed'}: ${message}`, !cancelled);
      repo.updateAiToolkitJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : message,
        finishedAt: Date.now(),
      });
    } finally {
      release();
      // Drop the runtime entry (log ring buffer + controller) well after
      // completion so a client that's mid-poll doesn't 404 on the log tail,
      // but the Map still can't grow unbounded across many old jobs.
      setTimeout(() => runtime.delete(jobId), RUNTIME_TTL_MS).unref();
    }
  }, controller.signal).catch((err) => {
    // Rejected before ever running run() — either cancelled while still
    // queued (submitGpuJob's signal wiring routes that through
    // scheduler.cancel()) or `ensureResident(oneshot)` itself threw (e.g.
    // eviction failed) before run() was ever invoked. Either way the job
    // never got to update its own row, so do it here — checking the
    // `cancelRequested` flag (rather than assuming every rejection here is a
    // cancellation) keeps a real startup failure labeled 'failed' instead of
    // being misreported as user-cancelled.
    const job = repo.getAiToolkitJob(jobId);
    const message = err instanceof Error ? err.message : String(err);
    if (job && job.status === 'queued') {
      const cancelled = runtime.get(jobId)?.cancelRequested === true;
      repo.updateAiToolkitJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : message,
        finishedAt: Date.now(),
      });
    }
    logger.info('[ai-toolkit] training job did not run', { jobId, message });
    // run()'s own `finally` (which normally schedules this) never executed
    // since run() itself was never invoked — clean up here instead so a
    // cancelled-while-queued job doesn't leak its runtime entry forever.
    setTimeout(() => runtime.delete(jobId), RUNTIME_TTL_MS).unref();
  });

  return { jobId };
}

export type CancelResult = 'cancelled' | 'not_found' | 'already_terminal';

/** Cancel a queued or running job. Queued: aborts the scheduler wait via
 *  `AbortController` (never occupies a slot). Running: SIGTERM the child,
 *  escalating to SIGKILL after a grace period if it hasn't exited. */
export function cancelTrainingJob(jobId: string): CancelResult {
  const job = repo.getAiToolkitJob(jobId);
  if (!job) return 'not_found';
  if (job.status !== 'queued' && job.status !== 'running') return 'already_terminal';

  const rt = runtime.get(jobId);
  if (!rt) {
    // Runtime state already gone (e.g. server restarted mid-run) — force the
    // DB row terminal so the UI isn't stuck polling a job nothing will ever
    // finish.
    repo.updateAiToolkitJob(jobId, { status: 'cancelled', finishedAt: Date.now() });
    return 'cancelled';
  }

  rt.cancelRequested = true;
  if (rt.child) {
    const child = rt.child;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, SIGKILL_GRACE_MS).unref();
  } else {
    rt.controller.abort();
  }
  return 'cancelled';
}

export function getTrainingJob(jobId: string): AiToolkitJobRow | null {
  return repo.getAiToolkitJob(jobId);
}

export function listTrainingJobs(limit?: number): AiToolkitJobRow[] {
  return repo.listAiToolkitJobs(limit);
}

/** Tail the in-memory log ring buffer for a job. Empty once the runtime
 *  entry has expired (`RUNTIME_TTL_MS` after completion) or after a server
 *  restart — the job's final status/error is still available via
 *  `getTrainingJob`, just not the line-by-line trainer output. */
export function getTrainingJobLogs(jobId: string, maxKb = 128): string[] {
  const rt = runtime.get(jobId);
  return rt ? rt.log.tail(maxKb) : [];
}
