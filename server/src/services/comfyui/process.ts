// ComfyUI process lifecycle: spawn, stop, reset helpers, log store,
// ProcessService orchestrator, and the module-level singleton.

import fs from 'fs';
import path from 'path';
import { type ChildProcess, spawn } from 'child_process';
import { env, currentProcessEnv } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import { run } from '../../lib/exec.js';
import { isComfyUIRunning } from './utils.js';
import { buildCliArgsString } from './launchOptions.js';

// ---- Spawn helpers ----

export interface SpawnContext {
  process: ChildProcess;
  argv: string[];
  cliArgs: string;
  startedAt: Date;
}

// Prefers the persisted launch-options config; falls back to env.CLI_ARGS.
export function resolveCliArgs(): string {
  const fromConfig = buildCliArgsString().trim();
  if (fromConfig) return fromConfig;
  return (env.CLI_ARGS || '').trim();
}

// Inherits the current environment then overlays the resolved CLI_ARGS.
export function buildChildEnv(cliArgs: string): NodeJS.ProcessEnv {
  return { ...currentProcessEnv(), CLI_ARGS: cliArgs };
}

export function spawnComfyUI(): SpawnContext {
  const cliArgs = resolveCliArgs();
  const argv = ['bash', env.COMFYUI_ENTRYPOINT];
  const childEnv = buildChildEnv(cliArgs);
  logger.info('comfyui spawn', { entrypoint: env.COMFYUI_ENTRYPOINT, hasCliArgs: cliArgs.length > 0 });
  const child = spawn(argv[0], argv.slice(1), {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    shell: false,
    windowsHide: true,
  });
  return { process: child, argv, cliArgs, startedAt: new Date() };
}

// ---- Stop helpers ----

/** Sleep for ms. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectComfyPids(): Promise<number[]> {
  const r = await run('ps', ['-eo', 'pid,rss,command'], { timeoutMs: 5_000 });
  if (r.code !== 0) return [];
  const out: number[] = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const rss = parseInt(parts[1], 10);
    const cmd = parts.slice(2).join(' ');
    if (!Number.isFinite(pid)) continue;
    if (cmd.includes('python') && Number.isFinite(rss) && rss > 100_000) {
      out.push(pid);
    }
  }
  return out;
}

async function killPid(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  try {
    process.kill(pid, signal);
  } catch (error) {
    logger.warn('kill failed', {
      pid, signal, message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function killComfyUIGeneric(graceMs: number): Promise<void> {
  const pids = await collectComfyPids();
  if (pids.length > 0) {
    logger.info('comfyui stop: found python processes', { pids });
    for (const pid of pids) await killPid(pid, 'SIGTERM');
    await sleep(graceMs);
    const survivors = await collectComfyPids();
    for (const pid of survivors) await killPid(pid, 'SIGKILL');
    return;
  }
  logger.info('comfyui stop: falling back to pkill');
  await run('pkill', ['-9', '-f', 'python'], { timeoutMs: 5_000 }).catch(() => { /* ignore */ });
}

// ---- Constants ----

export const MAX_LOG_ENTRIES = 10_000;
export const RESET_LOG_FILE = 'comfyui-reset.log';

// ---- Log store ----

export interface ComfyUILogStore {
  addLog(message: string, isError?: boolean): void;
  addResetLog(message: string, isError?: boolean): void;
  clearLogs(): void;
  clearResetLogs(): void;
  getRecentLogs(): string[];
  getResetLogs(): string[];
  /** Return last N KB of log contents (or all when store is smaller). */
  tail(maxKb?: number): string[];
}

// ---- Reset helpers ----

const NORMAL_PRESERVED = ['models', 'output', 'input', 'user', 'custom_nodes'];
const HARD_PRESERVED = ['models', 'output', 'input'];

function preservedDirsFor(mode: 'normal' | 'hard', comfyuiPath: string): string[] {
  const dirs = mode === 'normal' ? [...NORMAL_PRESERVED] : [...HARD_PRESERVED];
  const rel = env.DATA_DIR && path.relative(comfyuiPath, env.DATA_DIR);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    dirs.push(path.basename(env.DATA_DIR));
  }
  return dirs;
}

async function removePath(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch (error) {
    logger.warn('remove failed', {
      target, message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function clearDirectory(dirPath: string, removeSelf = false): Promise<void> {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    await removePath(path.join(dirPath, entry.name));
  }
  if (removeSelf) await removePath(dirPath);
}

export async function clearCacheIfPresent(log: Pick<ComfyUILogStore, 'addResetLog'>): Promise<void> {
  const cachePath = env.CACHE_DIR;
  if (!cachePath) {
    log.addResetLog('No cache directory configured; skipping cache cleanup');
    return;
  }
  if (!fs.existsSync(cachePath)) {
    log.addResetLog(`Cache directory does not exist: ${cachePath}`);
    return;
  }
  log.addResetLog(`Cleaning cache directory: ${cachePath}`);
  await clearDirectory(cachePath);
}

async function clearOneEntry(
  fullPath: string,
  isDir: boolean,
  name: string,
  log: Pick<ComfyUILogStore, 'addResetLog'>,
): Promise<void> {
  if (isDir) {
    log.addResetLog(`Deleting directory: ${name}`);
    await clearDirectory(fullPath, true);
  } else {
    log.addResetLog(`Deleting file: ${name}`);
    await removePath(fullPath);
  }
}

export async function clearComfyuiRoot(
  mode: 'normal' | 'hard',
  log: Pick<ComfyUILogStore, 'addResetLog'>,
): Promise<void> {
  const comfyuiPath = env.COMFYUI_PATH;
  if (!fs.existsSync(comfyuiPath)) {
    log.addResetLog(`ComfyUI path does not exist: ${comfyuiPath}`, true);
    return;
  }
  log.addResetLog(`Cleaning ComfyUI directory: ${comfyuiPath}`);
  const preserved = preservedDirsFor(mode, comfyuiPath);
  log.addResetLog(
    mode === 'normal'
      ? 'Normal mode: preserving models, output, input, user, custom_nodes'
      : 'Hard mode: preserving models, output, input',
  );
  const entries = fs.readdirSync(comfyuiPath, { withFileTypes: true });
  for (const entry of entries) {
    if (preserved.includes(entry.name)) {
      log.addResetLog(`Keeping directory: ${entry.name}`);
      continue;
    }
    const fullPath = path.join(comfyuiPath, entry.name);
    await clearOneEntry(fullPath, entry.isDirectory(), entry.name, log);
  }
}

export async function runRecoveryScript(log: Pick<ComfyUILogStore, 'addResetLog'>): Promise<void> {
  const script = env.COMFYUI_RECOVERY_SCRIPT;
  if (!fs.existsSync(script)) {
    log.addResetLog('No recovery script present; skipping');
    return;
  }
  log.addResetLog('Running recovery script');
  try {
    await run('chmod', ['+x', script], { timeoutMs: 5_000 });
    const result = await run('sh', [script], { timeoutMs: 60_000 });
    if (result.code !== 0) {
      log.addResetLog(`Recovery script exited with code ${result.code}`, true);
      return;
    }
    log.addResetLog('Recovery script completed');
  } catch (error) {
    log.addResetLog(
      `Recovery script failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

export class LogService implements ComfyUILogStore {
  private recentLogs: string[] = [];
  private resetLogs: string[] = [];

  // Returns the formatted (timestamped) entry so callers that need to relay
  // the exact line elsewhere (e.g. `services/aiToolkit/train.ts` broadcasting
  // it over WS) don't have to reconstruct the same formatting. `void`-typed
  // callers (this class `implements ComfyUILogStore`, whose interface
  // declares `addLog(...): void`) simply ignore the return value — TS allows
  // a non-void-returning method to satisfy a void-returning interface member.
  addLog(message: string, isError: boolean = false): string {
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${isError ? 'ERROR: ' : ''}${message}`;
    this.recentLogs.push(entry);
    if (this.recentLogs.length > MAX_LOG_ENTRIES) this.recentLogs.shift();
    if (isError) logger.error(message);
    else logger.info(message);
    return entry;
  }

  addResetLog(message: string, isError: boolean = false): void {
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${isError ? 'ERROR: ' : ''}${message}`;
    this.resetLogs.push(entry);
    // Mirror the recentLogs cap so the in-memory reset buffer can't grow
    // unbounded across long-lived processes. The on-disk log file still
    // accumulates the full history.
    if (this.resetLogs.length > MAX_LOG_ENTRIES) this.resetLogs.shift();
    if (isError) logger.error(message);
    else logger.info(message);
    this.appendResetLogFile(entry);
  }

  clearLogs(): void { this.recentLogs = []; }
  clearResetLogs(): void {
    this.resetLogs = [];
    try {
      const p = this.resetLogFilePath();
      if (fs.existsSync(p)) atomicWrite(p, '');
    } catch (error) {
      logger.error('reset log clear failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getRecentLogs(): string[] { return [...this.recentLogs]; }

  getResetLogs(): string[] {
    if (this.resetLogs.length === 0) {
      try {
        const p = this.resetLogFilePath();
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, 'utf-8');
          if (content.trim()) {
            this.resetLogs = content.split('\n').filter((l) => l.trim());
          }
        }
      } catch (error) {
        logger.error('reset log read failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return [...this.resetLogs];
  }

  tail(maxKb: number = 256): string[] {
    const lines = [...this.recentLogs];
    let total = 0;
    const limit = maxKb * 1024;
    const out: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const size = Buffer.byteLength(lines[i], 'utf-8') + 1;
      if (total + size > limit) break;
      out.unshift(lines[i]);
      total += size;
    }
    return out;
  }

  private resetLogFilePath(): string {
    return path.join(paths.resetLogsDir, RESET_LOG_FILE);
  }

  private appendResetLogFile(entry: string): void {
    try {
      const dir = paths.resetLogsDir;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.resetLogFilePath(), entry + '\n');
    } catch (error) {
      logger.error('reset log write failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let defaultLogService: LogService | null = null;
export function getDefaultLogService(): LogService {
  if (!defaultLogService) defaultLogService = new LogService();
  return defaultLogService;
}

/** Test helper: replace the module-level log singleton. */
export function setDefaultLogService(s: LogService | null): void {
  defaultLogService = s;
}

// ---- Response types ----

export interface ComfyUIStartResponse {
  success: boolean;
  message: string;
  pid?: number | null;
  logs?: string[];
}

export interface ComfyUIStopResponse {
  success: boolean;
  message: string;
  error?: string;
}

export interface ComfyUIResetResponse {
  success: boolean;
  message: string;
  logs?: string[];
}

// ---- ProcessService ----

export interface ProcessServiceDeps {
  spawn: () => SpawnContext;
  kill: (graceMs: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  clearCache: (log: Pick<ComfyUILogStore, 'addResetLog'>) => Promise<void>;
  clearRoot: (mode: 'normal' | 'hard', log: Pick<ComfyUILogStore, 'addResetLog'>) => Promise<void>;
  recover: (log: Pick<ComfyUILogStore, 'addResetLog'>) => Promise<void>;
}

function defaultDeps(): ProcessServiceDeps {
  return {
    spawn: spawnComfyUI,
    kill: killComfyUIGeneric,
    sleep,
    clearCache: clearCacheIfPresent,
    clearRoot: clearComfyuiRoot,
    recover: runRecoveryScript,
  };
}

export class ProcessService {
  private comfyProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private comfyPid: number | null = null;
  private readonly log: ComfyUILogStore;
  private readonly deps: ProcessServiceDeps;

  constructor(log?: ComfyUILogStore, deps?: ProcessServiceDeps) {
    this.log = log ?? new LogService();
    this.deps = deps ?? defaultDeps();
  }

  getComfyPid(): number | null { return this.comfyPid; }
  getStartTime(): Date | null { return this.startTime; }
  getLogStore(): ComfyUILogStore { return this.log; }

  /** Best-effort check: if port is open, find a matching python pid. */
  async checkIfComfyUIRunning(): Promise<void> {
    try {
      const running = await isComfyUIRunning();
      if (!running) return;
      const result = await run('ps', ['-eo', 'pid,command'], { timeoutMs: 5_000 });
      if (result.code !== 0) return;
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim();
        const parts = trimmed.split(/\s+/);
        const pid = parseInt(parts[0], 10);
        const cmd = parts.slice(1).join(' ');
        if (Number.isFinite(pid) && /python/i.test(cmd) && /comfyui|main\.py/i.test(cmd)) {
          this.comfyPid = pid;
          if (!this.startTime) this.startTime = new Date();
          logger.info('comfyui detected running', { pid });
          return;
        }
      }
    } catch (error) {
      logger.error('comfyui detection failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async startComfyUI(): Promise<ComfyUIStartResponse> {
    this.log.clearLogs();
    this.log.addLog('Received request to start ComfyUI');
    if (await isComfyUIRunning()) {
      this.log.addLog('ComfyUI is already running');
      return { success: false, message: 'ComfyUI is already running', pid: this.comfyPid };
    }
    try {
      const ctx = this.deps.spawn();
      this.comfyProcess = ctx.process;
      this.startTime = ctx.startedAt;
      this.log.addLog(`Using CLI args: ${ctx.cliArgs || '(empty)'}`);
      this.log.addLog(`Executing: ${ctx.argv.join(' ')}`);
      this.attachStdio(ctx.process);
      this.attachExit(ctx.process);
      return await this.waitForComfyUIReady();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.addLog(`Start failed: ${msg}`, true);
      return { success: false, message: `Start failed: ${msg}`, logs: this.log.getRecentLogs() };
    }
  }

  async stopComfyUI(): Promise<ComfyUIStopResponse> {
    try {
      if (!(await isComfyUIRunning())) {
        this.comfyPid = null;
        this.startTime = null;
        return { success: true, message: 'ComfyUI is already stopped' };
      }
      await this.deps.kill(env.COMFYUI_STOP_WAIT_MS);
      await this.deps.sleep(env.COMFYUI_STOP_WAIT_MS);
      if (!(await isComfyUIRunning())) {
        this.comfyPid = null;
        this.startTime = null;
        return { success: true, message: 'ComfyUI stopped' };
      }
      // One more forceful pass.
      await run('pkill', ['-9', '-f', 'python'], { timeoutMs: 5_000 }).catch(() => { /* ignore */ });
      await this.deps.sleep(1_000);
      if (!(await isComfyUIRunning())) {
        this.comfyPid = null;
        this.startTime = null;
        return { success: true, message: 'ComfyUI stopped (forced)' };
      }
      return { success: false, message: 'Failed to stop ComfyUI', error: 'Failed to stop ComfyUI' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: 'Error stopping ComfyUI', error: msg };
    }
  }

  async restartComfyUI(): Promise<ComfyUIStartResponse & { error?: string }> {
    const stop = await this.stopComfyUI();
    if (!stop.success) {
      return { success: false, message: 'Failed to stop before restart', error: stop.error };
    }
    await this.deps.sleep(env.COMFYUI_STOP_WAIT_MS);
    return this.startComfyUI();
  }

  async resetComfyUI(mode: 'normal' | 'hard' = 'normal'): Promise<ComfyUIResetResponse> {
    this.log.clearResetLogs();
    this.log.addResetLog(`ComfyUI reset started (mode: ${mode})`);
    try {
      if (await isComfyUIRunning()) {
        this.log.addResetLog('Stopping running ComfyUI');
        await this.deps.kill(env.COMFYUI_STOP_WAIT_MS);
        await this.deps.sleep(env.COMFYUI_STOP_WAIT_MS);
        if (await isComfyUIRunning()) {
          this.log.addResetLog('Failed to stop ComfyUI; aborting reset', true);
          return { success: false, message: 'Failed to stop ComfyUI' };
        }
        this.comfyPid = null;
        this.startTime = null;
      }
      await this.deps.clearCache(this.log);
      await this.deps.clearRoot(mode, this.log);
      await this.deps.recover(this.log);
      this.log.addResetLog('ComfyUI reset completed');
      return { success: true, message: 'ComfyUI reset completed' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.addResetLog(`Reset failed: ${msg}`, true);
      return { success: false, message: `Reset failed: ${msg}`, logs: this.log.getResetLogs() };
    }
  }

  private attachStdio(child: ChildProcess): void {
    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString('utf-8').trim();
      if (line) this.log.addLog(`[ComfyUI] ${line}`);
    });
    // Python writes a lot of plain info to stderr (alembic, logging,
    // SaveImage/MaskEditor messages, etc.). Tagging every stderr line as
    // an error floods the UI with false positives. Detect real errors by
    // markers; otherwise log as info.
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString('utf-8').trim();
      if (!line) return;
      const isError = /\b(error|traceback|exception|fatal|critical)\b/i.test(line);
      this.log.addLog(`[ComfyUI${isError ? '-Error' : ''}] ${line}`, isError);
    });
  }

  private attachExit(child: ChildProcess): void {
    child.on('exit', (code, signal) => {
      this.log.addLog(`ComfyUI exited (code=${code}, signal=${signal ?? 'none'})`);
      this.comfyProcess = null;
      void this.checkIfComfyUIRunning().then(async () => {
        if (!(await isComfyUIRunning())) {
          this.comfyPid = null;
          this.startTime = null;
        }
      });
    });
    child.on('error', (err) => {
      this.log.addLog(`ComfyUI process error: ${err.message}`, true);
      this.comfyProcess = null;
    });
  }

  private async waitForComfyUIReady(): Promise<ComfyUIStartResponse> {
    const maxRetries = env.COMFYUI_START_RETRIES;
    for (let retry = 0; retry < maxRetries; retry++) {
      await this.deps.sleep(5_000);
      if (await isComfyUIRunning()) {
        await this.checkIfComfyUIRunning();
        this.log.addLog('ComfyUI started');
        return { success: true, message: 'ComfyUI started', pid: this.comfyPid };
      }
      this.log.addLog(`Waiting for ComfyUI to start (${retry + 1}/${maxRetries})`);
    }
    this.log.addLog('ComfyUI start timeout', true);
    if (this.comfyProcess) { try { this.comfyProcess.kill(); } catch { /* ignore */ } this.comfyProcess = null; }
    this.startTime = null;
    return { success: false, message: 'ComfyUI start failed or timed out', logs: this.log.getRecentLogs() };
  }
}

// ---- Singleton ----
// Lazy initialization lets tests swap it via setProcessService(null).

let instance: ProcessService | null = null;

export function getProcessService(): ProcessService {
  if (!instance) {
    instance = new ProcessService(getDefaultLogService());
    // Fire-and-forget initial detection so already-running ComfyUI is
    // reflected in status without needing an explicit /start call.
    void instance.checkIfComfyUIRunning();
  }
  return instance;
}

/** Test helper: swap the module-level instance (pass null to reset). */
export function setProcessService(svc: ProcessService | null): void {
  instance = svc;
}
