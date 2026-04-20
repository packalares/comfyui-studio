// ComfyUI process lifecycle orchestrator. Argv-only subprocess invocation
// via lib/exec. Helpers are split across process.spawn.ts, process.stop.ts,
// and process.reset.ts to keep this file under the 250-line cap.

import { type ChildProcess } from 'child_process';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { run } from '../../lib/exec.js';
import { isComfyUIRunning } from './utils.js';
import { LogService, type ComfyUILogStore } from './log.service.js';
import { spawnComfyUI } from './process.spawn.js';
import { killComfyUIGeneric, sleep } from './process.stop.js';
import { clearCacheIfPresent, clearComfyuiRoot, runRecoveryScript } from './process.reset.js';
import type {
  ComfyUIStartResponse, ComfyUIStopResponse, ComfyUIResetResponse,
} from './types.js';

export class ProcessService {
  private comfyProcess: ChildProcess | null = null;
  private startTime: Date | null = null;
  private comfyPid: number | null = null;
  private readonly log: ComfyUILogStore;

  constructor(log?: ComfyUILogStore) {
    this.log = log ?? new LogService();
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
      const ctx = spawnComfyUI();
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
      await killComfyUIGeneric(env.COMFYUI_STOP_WAIT_MS);
      await sleep(env.COMFYUI_STOP_WAIT_MS);
      if (!(await isComfyUIRunning())) {
        this.comfyPid = null;
        this.startTime = null;
        return { success: true, message: 'ComfyUI stopped' };
      }
      // One more forceful pass.
      await run('pkill', ['-9', '-f', 'python'], { timeoutMs: 5_000 }).catch(() => { /* ignore */ });
      await sleep(1_000);
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
    await sleep(env.COMFYUI_STOP_WAIT_MS);
    return this.startComfyUI();
  }

  async resetComfyUI(mode: 'normal' | 'hard' = 'normal'): Promise<ComfyUIResetResponse> {
    this.log.clearResetLogs();
    this.log.addResetLog(`ComfyUI reset started (mode: ${mode})`);
    try {
      if (await isComfyUIRunning()) {
        this.log.addResetLog('Stopping running ComfyUI');
        await killComfyUIGeneric(env.COMFYUI_STOP_WAIT_MS);
        await sleep(env.COMFYUI_STOP_WAIT_MS);
        if (await isComfyUIRunning()) {
          this.log.addResetLog('Failed to stop ComfyUI; aborting reset', true);
          return { success: false, message: 'Failed to stop ComfyUI' };
        }
        this.comfyPid = null;
        this.startTime = null;
      }
      await clearCacheIfPresent(this.log);
      await clearComfyuiRoot(mode, this.log);
      await runRecoveryScript(this.log);
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
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString('utf-8').trim();
      if (line) this.log.addLog(`[ComfyUI-Error] ${line}`, true);
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
      await sleep(5_000);
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
