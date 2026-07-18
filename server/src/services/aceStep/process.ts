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
import { currentProcessEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { LogService, sleep, type ComfyUILogStore } from '../comfyui/process.js';

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

// argv-only, no shell: the whole FastAPI app is booted from a `-c` snippet
// so we don't depend on a bundled launcher script existing on disk.
const ACESTEP_BOOTSTRAP =
  'from acestep.api_server import create_app; import uvicorn; ' +
  `uvicorn.run(create_app(), host="${ACESTEP_HOST}", port=${ACESTEP_PORT})`;

/** Inherits the current environment then forces ACE-Step's CPU-offload flag. */
export function buildAceStepChildEnv(): NodeJS.ProcessEnv {
  // Idle weights get pushed to host RAM so ACE-Step only holds active
  // tensors in VRAM — required since it shares the single GPU with
  // comfy/ollama/lora-train.
  return { ...currentProcessEnv(), ACESTEP_OFFLOAD_TO_CPU: 'true' };
}

export function spawnAceStep(): AceStepSpawnContext {
  const argv = ['python3', '-c', ACESTEP_BOOTSTRAP];
  const childEnv = buildAceStepChildEnv();
  logger.info('ace-step spawn', { host: ACESTEP_HOST, port: ACESTEP_PORT });
  const child = spawn(argv[0], argv.slice(1), {
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

export class AceStepProcessService {
  private aceProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private readonly log: ComfyUILogStore;
  private readonly deps: AceStepProcessServiceDeps;

  constructor(log?: ComfyUILogStore, deps?: AceStepProcessServiceDeps) {
    this.log = log ?? new LogService();
    this.deps = deps ?? defaultDeps();
  }

  getPid(): number | null { return this.aceProcess?.pid ?? null; }
  getStartTime(): Date | null { return this.startTime; }
  getLogStore(): ComfyUILogStore { return this.log; }
  getRecentLogs(): string[] { return this.log.getRecentLogs(); }

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
    try {
      const ctx = this.deps.spawn();
      this.aceProcess = ctx.process;
      this.startTime = ctx.startedAt;
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
      }
    });
    child.on('error', (err) => {
      this.log.addLog(`ACE-Step process error: ${err.message}`, true);
      if (this.aceProcess === child) this.aceProcess = null;
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
