// In-memory + file-backed log store for ComfyUI process output and reset
// operations. Kept intentionally simple: launcher's original version also
// carried an i18n/translation pipeline. Studio emits English-only so the
// translation layer is dropped.

import fs from 'fs';
import path from 'path';
import { atomicWrite } from '../../lib/fs.js';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { MAX_LOG_ENTRIES, RESET_LOG_FILE } from './types.js';

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

export class LogService implements ComfyUILogStore {
  private recentLogs: string[] = [];
  private resetLogs: string[] = [];

  addLog(message: string, isError: boolean = false): void {
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${isError ? 'ERROR: ' : ''}${message}`;
    this.recentLogs.push(entry);
    if (this.recentLogs.length > MAX_LOG_ENTRIES) this.recentLogs.shift();
    if (isError) logger.error(message);
    else logger.info(message);
  }

  addResetLog(message: string, isError: boolean = false): void {
    const ts = new Date().toISOString();
    const entry = `[${ts}] ${isError ? 'ERROR: ' : ''}${message}`;
    this.resetLogs.push(entry);
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

  private resetLogDir(): string {
    return path.join(paths.dataDir, 'logs');
  }

  private resetLogFilePath(): string {
    return path.join(this.resetLogDir(), RESET_LOG_FILE);
  }

  private appendResetLogFile(entry: string): void {
    try {
      const dir = this.resetLogDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.resetLogFilePath(), entry + '\n');
    } catch (error) {
      logger.error('reset log write failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Shared default log-store instance. Services and tests can also construct
 * their own LogService directly — the singleton simply wires process output
 * to a well-known sink used by all ports.
 */
let defaultLogService: LogService | null = null;
export function getDefaultLogService(): LogService {
  if (!defaultLogService) defaultLogService = new LogService();
  return defaultLogService;
}

/** Test helper: replace the module-level singleton. */
export function setDefaultLogService(s: LogService | null): void {
  defaultLogService = s;
}
