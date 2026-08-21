// ACE-Step FastAPI backend process lifecycle: spawn, stop, restart, readiness
// poll, ProcessService orchestrator, and the module-level singleton.
//
// Mirrors comfyui/process.ts's shape (spawn/kill/sleep are injectable deps,
// same start/stop/restart/reset-style flow) since ACE-Step is a second,
// independent Python backend (music generation + training) that shares the
// same GPU and needs the same supervised lifecycle. The in-memory log ring
// buffer is NOT reimplemented — `LogService` is imported from comfyui/process.ts
// and reused as-is.
//
// Unlike ComfyUI (launched via a bash entrypoint, so the real python
// descendant has to be found afterwards via `ps`), we spawn `python3`
// directly — the ChildProcess handle we hold IS the server, so a direct
// SIGTERM/SIGKILL is sufficient to stop it.

import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { currentProcessEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { LogService, sleep, type ComfyUILogStore } from '../comfyui/process.js';
import { resolvePackPython } from '../packs/registry.js';
import { resolveAceStepModelsRoot } from '../packs/modelPaths.js';

// ---- Constants ----

// Bind loopback ONLY — this backend has no auth of its own, so it must never
// be reachable off-box.
const ACESTEP_HOST = '127.0.0.1';
const ACESTEP_PORT = 8000;
const ACESTEP_HEALTH_URL = `http://${ACESTEP_HOST}:${ACESTEP_PORT}/health`;

// Readiness poll cadence/ceiling. ACE-Step's model load can be as heavy as
// ComfyUI's cold start, so we budget the same ~10 minutes (120 * 5s).
const ACESTEP_START_RETRIES = 120;
const ACESTEP_START_POLL_MS = 5_000;
const ACESTEP_STOP_WAIT_MS = 2_000;
const ACESTEP_HEALTH_TIMEOUT_MS = 2_000;

// ---- Spawn helpers ----

export interface AceStepSpawnContext {
  process: ChildProcess;
  argv: string[];
  startedAt: Date;
}

/**
 * Force `dcw_enabled=False` on non-turbo checkpoints.
 *
 * THE BUG. DCW ("Differential Correction in Wavelet domain") defaults to
 * `True` on `GenerationParams` (`acestep/inference.py`, the `dcw_enabled`
 * field). ACE-Step's own Gradio UI sets it to `False` for the non-turbo
 * checkpoints — `ui/gradio/events/generation/model_config.py` has
 * `dcw_enabled_value: False` in the base/SFT branch — but Gradio can do that
 * only because it runs in-process and calls `generate_music()` directly.
 *
 * We drive ACE-Step over HTTP, and its request model
 * (`api/http/release_task_models.py`) has 59 fields, none of which is
 * `dcw_enabled`, while the Python dataclass has 108. `api/job_generation_setup.py`
 * builds `GenerationParams(...)` from the request and never passes it, so every
 * REST generation silently takes the `True` default. Correct for turbo; it
 * garbles XL-Base and XL-SFT into robotic noise. Confirmed by ear: the same
 * base checkpoint at guidance 7 with `dcw_enabled=False` through Gradio sounds
 * clean. No parameter we can send over HTTP changes it — the setting simply
 * isn't reachable, which is why tuning CFG/steps/LM all did nothing.
 *
 * WHY THIS TARGET. `api_server.py` does a module-level
 * `from acestep.inference import (...)`, binding `generate_music` into its own
 * namespace at import time. Patching `acestep.inference.generate_music` would
 * therefore no-op — the API path never looks there again. We patch
 * `acestep.api_server.generate_music` instead, which its job runner resolves
 * from module globals per call (`generate_music_fn=generate_music`), so
 * replacing the attribute before `create_app()` catches every generation.
 *
 * WHY NOT JUST FLIP THE DEFAULT. The checkpoint is chosen per request, not per
 * process, so a process-wide default would be wrong for whichever model the
 * next request picks. The wrapper branches per call on the handler's own
 * `config.is_turbo` — the same field upstream's `is_turbo_model()` reads.
 *
 * Deliberately conservative: we act ONLY when the config positively carries an
 * `is_turbo` attribute, and leave `dcw_enabled` untouched otherwise.
 *
 * That `hasattr` check is not defensive padding — it's the difference between
 * this patch being safe and being a landmine. Upstream's own `is_turbo_model()`
 * reads `getattr(self.config, "is_turbo", False)`, so a MISSING attribute reads
 * as "not turbo". Upstream only uses that value to emit a guidance warning, so
 * a wrong `False` costs nothing there. Here a wrong `False` would switch DCW
 * off for a turbo checkpoint — degrading the one configuration that was never
 * broken. Absent evidence, do nothing.
 *
 * Every decision is logged: a monkeypatch that misses its target otherwise
 * fails silently and is indistinguishable from the bug it was meant to fix.
 */
const ACESTEP_DCW_PATCH = [
  'import acestep.api_server as _ace_api',
  '_ace_dcw_orig = _ace_api.generate_music',
  'def _ace_dcw_wrapper(*args, **kwargs):',
  '    _p = kwargs.get("params")',
  '    _d = kwargs.get("dit_handler")',
  '    _c = getattr(_d, "config", None) if _d is not None else None',
  '    if _p is None or _c is None or not hasattr(_c, "is_turbo"):',
  '        print("[dcw-patch] cannot positively identify the checkpoint'
    + ' (params=%r config=%r is_turbo_attr=%r); leaving dcw_enabled untouched"'
    + ' % (_p is not None, _c is not None, hasattr(_c, "is_turbo")), flush=True)',
  '    else:',
  '        _turbo = bool(_c.is_turbo)',
  '        if not _turbo:',
  '            _p.dcw_enabled = False',
  '        print("[dcw-patch] is_turbo=%s -> dcw_enabled=%s" %'
    + ' (_turbo, getattr(_p, "dcw_enabled", None)), flush=True)',
  '    return _ace_dcw_orig(*args, **kwargs)',
  '_ace_api.generate_music = _ace_dcw_wrapper',
  'print("[dcw-patch] installed on acestep.api_server.generate_music", flush=True)',
].join('\n');

// argv-only, no shell: the whole FastAPI app is booted from a `-c` snippet
// so we don't depend on a bundled launcher script existing on disk.
//
// Multi-line rather than the original single `;`-joined line because the DCW
// wrapper needs a real `def`. `reclaimOrphanedAceStep()` still identifies the
// process by the `acestep.api_server` + `main-venv` substrings, both of which
// survive here.
const ACESTEP_BOOTSTRAP = [
  ACESTEP_DCW_PATCH,
  'import uvicorn',
  `uvicorn.run(_ace_api.create_app(), host="${ACESTEP_HOST}", port=${ACESTEP_PORT})`,
].join('\n');

/**
 * ACE-Step's own `get_project_root()` (acestep/model_downloader.py) returns
 * `$ACESTEP_PROJECT_ROOT` if set, else `os.getcwd()` — and it downloads its
 * model weights (`<project_root>/checkpoints/...`) under whatever that
 * resolves to. Left unset, that lands wherever this Node process happened to
 * be launched from (or, worse, inside the `main` venv directory itself —
 * `services/packs/install.ts`'s self-healing guards `rm -rf` that venv on a
 * detected wrong-Python-version/missing-pip venv, which would silently
 * destroy tens of GB of already-downloaded weights living under it).
 *
 * Pinning it to `resolveAceStepModelsRoot()` (`<comfy models>/ace-step`)
 * fixes both problems at once: that directory is never touched by the venv
 * installer, AND it's the exact root `services/packs/modelPaths.ts`'s
 * `resolvePackModelDest` already downloads the pack's checkpoints into
 * (`<that root>/checkpoints/<repoName>`) — so ACE-Step finds the weights we
 * already fetched instead of re-downloading its own copy.
 */
function resolveAceStepProjectRoot(): string {
  const root = resolveAceStepModelsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  return root;
}

/** `<project root>/checkpoints` — the directory `services/packs/modelPaths.ts`
 *  already downloads both `kind: 'checkpoint'` and `kind: 'lm'` models into,
 *  and the one ACE-Step itself reads/writes when `ACESTEP_CHECKPOINTS_DIR` is
 *  set. Keeping the two in agreement is what stops ACE-Step re-fetching
 *  weights the pack has already placed. */
function resolveAceStepCheckpointsDir(): string {
  const dir = path.join(resolveAceStepProjectRoot(), 'checkpoints');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

/**
 * Point ACE-Step's HARDCODED checkpoint directory at our consolidated one.
 *
 * This exists because the environment variables are not sufficient, which cost
 * two rounds of "fixed it" / "still downloading" to establish:
 *
 *   acestep/api_server.py
 *     def _get_project_root() -> str:
 *         current_file = os.path.abspath(__file__)
 *         return os.path.dirname(os.path.dirname(current_file))
 *
 * That resolves to the package's own install directory — `<site-packages>` —
 * from `__file__`, and `startup_model_init.py` then does
 * `os.path.join(project_root, "checkpoints")`. It consults NO env var and NOT
 * the cwd. `ACESTEP_PROJECT_ROOT` / `ACESTEP_CHECKPOINTS_DIR` are honoured by
 * `model_downloader.py`, but the API server's startup model-init path — the
 * one that actually fetches the DiT/VAE/LM at boot — bypasses it entirely.
 * With both vars set correctly and a matching cwd, it still re-downloaded
 * ~17 GB into the venv.
 *
 * Since the path is baked in, we make that path BE the right directory: a
 * symlink from `<site-packages>/checkpoints` to the consolidated tree. Done on
 * every spawn rather than once at install, because `install.ts`'s self-healing
 * guards delete and recreate the venv (taking the symlink with it), and a
 * stale/broken link would silently resurrect the re-download.
 *
 * Deliberately conservative: if a REAL directory is already there we leave it
 * alone and warn, rather than deleting what could be gigabytes of weights an
 * operator put there deliberately. Only a missing entry or an existing symlink
 * (ours, possibly pointing somewhere stale) is touched.
 */
function linkAceStepCheckpointsIntoVenv(pythonBin: string, target: string): void {
  // `<venv>/bin/python` -> `<venv>`
  const venvDir = path.dirname(path.dirname(pythonBin));
  const libDir = path.join(venvDir, 'lib');
  let pyDir: string | undefined;
  try {
    pyDir = fs.readdirSync(libDir).find((n) => /^python3\.\d+$/.test(n));
  } catch {
    logger.warn('[ace-step] venv lib dir unreadable; skipping checkpoint symlink', { libDir });
    return;
  }
  if (!pyDir) {
    logger.warn('[ace-step] no python3.x dir in venv; skipping checkpoint symlink', { libDir });
    return;
  }
  const link = path.join(libDir, pyDir, 'site-packages', 'checkpoints');

  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(link);
  } catch {
    existing = null;
  }

  if (existing?.isSymbolicLink()) {
    if (fs.readlinkSync(link) === target) return; // already correct
    fs.unlinkSync(link);
  } else if (existing) {
    logger.warn(
      '[ace-step] a real checkpoints directory exists inside the venv; leaving it in place. '
      + 'ACE-Step will use it instead of the shared models tree and may re-download weights. '
      + 'Move its contents into the shared tree and delete it to fix.',
      { link, target },
    );
    return;
  }

  fs.symlinkSync(target, link, 'dir');
  logger.info('[ace-step] linked venv checkpoints dir to shared models tree', { link, target });
}

/** Inherits the current environment then forces ACE-Step's CPU-offload flag
 *  and pins its project root (see `resolveAceStepProjectRoot`). */
export function buildAceStepChildEnv(): NodeJS.ProcessEnv {
  // Idle weights get pushed to host RAM so ACE-Step only holds active
  // tensors in VRAM — required since it shares the single GPU with
  // comfy/ollama/lora-train.
  return {
    ...currentProcessEnv(),
    ACESTEP_OFFLOAD_TO_CPU: 'true',
    ACESTEP_PROJECT_ROOT: resolveAceStepProjectRoot(),
    // `ACESTEP_PROJECT_ROOT` alone is NOT enough, verified the hard way: with
    // only that set (and a matching cwd), ACE-Step still downloaded a fresh
    // `acestep-v15-xl-base` into `<venv>/site-packages/checkpoints/` — the very
    // directory whose contents we had just consolidated out. Not every call
    // site derives its checkpoint dir from the project root; the download path
    // resolves it independently.
    //
    // `ACESTEP_CHECKPOINTS_DIR` is the knob actually built for this. From
    // `model_downloader.get_checkpoints_dir`'s own docstring it takes priority
    // over the project root and exists to "share a single model directory
    // across multiple ACE-Step installations, avoiding duplicate downloads that
    // waste disk space" — exactly our case. Note it points at the `checkpoints`
    // directory ITSELF, not its parent like `ACESTEP_PROJECT_ROOT` does.
    ACESTEP_CHECKPOINTS_DIR: resolveAceStepCheckpointsDir(),
  };
}

/** `kill(pid, 0)` performs the permission/existence check without delivering
 *  a signal — the standard liveness probe. EPERM means it exists but belongs
 *  to another user, which still counts as alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function spawnAceStep(): AceStepSpawnContext {
  // Throws a clear "install the ace-step pack" error (never a raw
  // ImportError from inside the spawned child) if the `main` venv
  // component (registry.ts) hasn't been provisioned yet.
  const pythonBin = resolvePackPython('ace-step', 'main', 'ACE-Step music generation');
  // Must happen BEFORE the child starts: its startup model-init reads the
  // hardcoded `<site-packages>/checkpoints` path immediately on boot, and if
  // that isn't already pointing at the shared tree it begins re-downloading
  // weights we already have. See `linkAceStepCheckpointsIntoVenv`.
  linkAceStepCheckpointsIntoVenv(pythonBin, resolveAceStepCheckpointsDir());
  const argv = [pythonBin, '-c', ACESTEP_BOOTSTRAP];
  const childEnv = buildAceStepChildEnv();
  // Explicit cwd — never depend on wherever this Node process happened to be
  // launched from. Same directory `ACESTEP_PROJECT_ROOT` points at above, so
  // `os.getcwd()`-based fallbacks inside acestep agree with the env var.
  const cwd = resolveAceStepProjectRoot();
  logger.info('ace-step spawn', { host: ACESTEP_HOST, port: ACESTEP_PORT, cwd });
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    shell: false,
    windowsHide: true,
  });
  return { process: child, argv, startedAt: new Date() };
}

// ---- Stop helper ----

export async function killAceStepProcess(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch (error) {
    logger.warn('ace-step kill failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  await sleep(graceMs);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

// ---- Readiness probe ----

export async function isAceStepHealthy(): Promise<boolean> {
  try {
    const res = await fetch(ACESTEP_HEALTH_URL, {
      signal: AbortSignal.timeout(ACESTEP_HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- Response types ----

export interface AceStepStartResponse {
  success: boolean;
  message: string;
  pid?: number | null;
  logs?: string[];
}

export interface AceStepStopResponse {
  success: boolean;
  message: string;
  error?: string;
}

// ---- ProcessService ----

export interface AceStepProcessServiceDeps {
  spawn: () => AceStepSpawnContext;
  kill: (child: ChildProcess, graceMs: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  checkHealthy: () => Promise<boolean>;
}

function defaultDeps(): AceStepProcessServiceDeps {
  return {
    spawn: spawnAceStep,
    kill: killAceStepProcess,
    sleep,
    checkHealthy: isAceStepHealthy,
  };
}

/** DiT checkpoint + 5Hz-LM pair currently loaded in the running ACE-Step
 *  process, per `POST /v1/init` — see `getLoadedModel`/`setLoadedModel`. */
export interface AceStepLoadedModel {
  dit: string;
  lm: string;
}

export class AceStepProcessService {
  private aceProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private readonly log: ComfyUILogStore;
  private readonly deps: AceStepProcessServiceDeps;
  // Tracks what `POST /v1/init` last successfully loaded into THIS process,
  // so `routes/ace/generate.routes.ts` can skip a redundant `/v1/init`
  // round-trip (multi-second model swap) when the requested checkpoint/LM
  // pair is already resident. Reset to null whenever the process (re)spawns
  // or exits — a fresh process has nothing loaded regardless of what the
  // previous one had.
  private loadedModel: AceStepLoadedModel | null = null;

  constructor(log?: ComfyUILogStore, deps?: AceStepProcessServiceDeps) {
    this.log = log ?? new LogService();
    this.deps = deps ?? defaultDeps();
  }

  getPid(): number | null { return this.aceProcess?.pid ?? null; }

  /**
   * Find and kill an ACE-Step left over from a previous run of this server.
   *
   * Identified by scanning `/proc/<pid>/cmdline` for our own bootstrap string
   * rather than by port: we must be certain we're killing OUR process and not
   * some unrelated thing that happens to hold 8000. `ACESTEP_BOOTSTRAP` is a
   * distinctive one-liner only this service ever spawns, and we additionally
   * require the pack venv's python in argv[0], so a false positive would have
   * to be a deliberate impersonation.
   *
   * Skips our own pid defensively — reading /proc can otherwise match the
   * scanner itself if the pattern ever appears in this process's own cmdline.
   */
  private async reclaimOrphanedAceStep(): Promise<void> {
    let pids: number[];
    try {
      pids = fs.readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number)
        .filter((pid) => pid !== process.pid)
        .filter((pid) => {
          try {
            // cmdline is NUL-separated; join so substring checks work.
            const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
            return cmd.includes('acestep.api_server') && cmd.includes('main-venv');
          } catch {
            return false; // vanished mid-scan, or not ours to read
          }
        });
    } catch {
      // Not Linux, or /proc unavailable — nothing we can do; a port clash will
      // surface as a clear bind error in the child's logs.
      return;
    }
    if (pids.length === 0) return;

    for (const pid of pids) {
      this.log.addLog(`Found orphaned ACE-Step (pid ${pid}) from a previous server run — terminating it`);
      logger.warn('[ace-step] reclaiming orphaned process', { pid });
      try {
        process.kill(pid, 'SIGTERM');
      } catch { /* already gone */ }
    }

    // Give them a moment to release the port, then escalate. Without this the
    // immediate respawn can still lose the bind race.
    for (let i = 0; i < 20; i += 1) {
      if (!pids.some((pid) => isProcessAlive(pid))) return;
      await sleep(250);
    }
    for (const pid of pids.filter(isProcessAlive)) {
      this.log.addLog(`Orphaned ACE-Step (pid ${pid}) did not exit; sending SIGKILL`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
    }
    await sleep(500);
  }
  getStartTime(): Date | null { return this.startTime; }
  getLogStore(): ComfyUILogStore { return this.log; }
  getRecentLogs(): string[] { return this.log.getRecentLogs(); }

  /** The `{dit, lm}` pair currently loaded via `/v1/init`, or `null` if
   *  nothing has been explicitly loaded on this process yet. */
  getLoadedModel(): AceStepLoadedModel | null { return this.loadedModel; }

  /** Record what `switchModel()`/`/v1/init` just successfully loaded (or
   *  `null` to clear, e.g. on process exit). */
  setLoadedModel(model: AceStepLoadedModel | null): void { this.loadedModel = model; }

  async isAceStepRunning(): Promise<boolean> {
    if (!this.aceProcess) return false;
    return this.deps.checkHealthy();
  }

  async startAceStep(): Promise<AceStepStartResponse> {
    this.log.clearLogs();
    this.log.addLog('Received request to start ACE-Step');
    if (this.aceProcess && (await this.deps.checkHealthy())) {
      this.log.addLog('ACE-Step is already running');
      return { success: false, message: 'ACE-Step is already running', pid: this.getPid() };
    }
    // No handle, but something may still be serving on our port: ACE-Step is
    // spawned as a NON-detached child, and Node does not kill children when it
    // exits. So every restart of this server (a `tsx watch` reload after a
    // code sync, a crash, a redeploy) leaves the previous ACE-Step alive and
    // reparented to init, still bound to 127.0.0.1:8000. The fresh service
    // object has `aceProcess === null`, concludes nothing is running, spawns a
    // second one, and that one dies with:
    //
    //     [Errno 98] error while attempting to bind on address
    //     ('127.0.0.1', 8000): address already in use
    //
    // leaving generation broken until someone manually kills the orphan.
    //
    // We reclaim rather than adopt. Adopting (treating a healthy orphan as
    // ours) would fix the port clash but leave a process we cannot stop — and
    // stopping ACE-Step is exactly what `services/gpu/residency.ts` must do to
    // hand the GPU to another tenant. An unstoppable resident would squat
    // ~19 GB of VRAM forever. Killing and respawning costs one cold start and
    // restores full lifecycle control.
    if (!this.aceProcess) {
      await this.reclaimOrphanedAceStep();
    }
    try {
      const ctx = this.deps.spawn();
      this.aceProcess = ctx.process;
      this.startTime = ctx.startedAt;
      // A freshly spawned process has nothing loaded yet, whatever the
      // previous process's tracked state was.
      this.loadedModel = null;
      this.log.addLog(`Executing: ${ctx.argv.join(' ')}`);
      this.attachStdio(ctx.process);
      this.attachExit(ctx.process);
      return await this.waitForAceStepReady();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.addLog(`Start failed: ${msg}`, true);
      return { success: false, message: `Start failed: ${msg}`, logs: this.log.getRecentLogs() };
    }
  }

  async stopAceStep(): Promise<AceStepStopResponse> {
    try {
      if (!this.aceProcess) {
        this.startTime = null;
        return { success: true, message: 'ACE-Step is already stopped' };
      }
      await this.deps.kill(this.aceProcess, ACESTEP_STOP_WAIT_MS);
      this.aceProcess = null;
      this.startTime = null;
      this.loadedModel = null;
      return { success: true, message: 'ACE-Step stopped' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: 'Error stopping ACE-Step', error: msg };
    }
  }

  async restartAceStep(): Promise<AceStepStartResponse & { error?: string }> {
    const stop = await this.stopAceStep();
    if (!stop.success) {
      return { success: false, message: 'Failed to stop before restart', error: stop.error };
    }
    await this.deps.sleep(ACESTEP_STOP_WAIT_MS);
    return this.startAceStep();
  }

  private attachStdio(child: ChildProcess): void {
    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString('utf-8').trim();
      if (line) this.log.addLog(`[ACE-Step] ${line}`);
    });
    // Same heuristic as ComfyUI's stdio handler: python backends write a lot
    // of benign info to stderr, so only tag lines matching error markers.
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString('utf-8').trim();
      if (!line) return;
      const isError = /\b(error|traceback|exception|fatal|critical)\b/i.test(line);
      this.log.addLog(`[ACE-Step${isError ? '-Error' : ''}] ${line}`, isError);
    });
  }

  private attachExit(child: ChildProcess): void {
    child.on('exit', (code, signal) => {
      this.log.addLog(`ACE-Step exited (code=${code}, signal=${signal ?? 'none'})`);
      if (this.aceProcess === child) {
        this.aceProcess = null;
        this.startTime = null;
        this.loadedModel = null;
      }
    });
    child.on('error', (err) => {
      this.log.addLog(`ACE-Step process error: ${err.message}`, true);
      if (this.aceProcess === child) {
        this.aceProcess = null;
        this.loadedModel = null;
      }
    });
  }

  private async waitForAceStepReady(): Promise<AceStepStartResponse> {
    for (let retry = 0; retry < ACESTEP_START_RETRIES; retry++) {
      await this.deps.sleep(ACESTEP_START_POLL_MS);
      if (await this.deps.checkHealthy()) {
        this.log.addLog('ACE-Step started');
        return { success: true, message: 'ACE-Step started', pid: this.getPid() };
      }
      this.log.addLog(`Waiting for ACE-Step to start (${retry + 1}/${ACESTEP_START_RETRIES})`);
    }
    this.log.addLog('ACE-Step start timeout', true);
    if (this.aceProcess) { try { this.aceProcess.kill(); } catch { /* ignore */ } this.aceProcess = null; }
    this.startTime = null;
    return { success: false, message: 'ACE-Step start failed or timed out', logs: this.log.getRecentLogs() };
  }
}

// ---- Singleton ----
// Lazy initialization lets tests swap it via setAceStepProcessService(null).

let instance: AceStepProcessService | null = null;

export function getAceStepProcessService(): AceStepProcessService {
  if (!instance) instance = new AceStepProcessService();
  return instance;
}

/** Test helper: swap the module-level instance (pass null to reset). */
export function setAceStepProcessService(svc: AceStepProcessService | null): void {
  instance = svc;
}
