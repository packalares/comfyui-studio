// Per-check log persistence. Each network check writes a small JSON log
// file under `paths.networkCheckDir`. The in-memory Map keeps the N most
// recent logs for quick polling; older entries are evicted and remain on
// disk for post-hoc inspection.
//
// Log ids are validated with a tight regex so HTTP callers cannot traverse
// out of the check directory.

import fs from 'fs';
import path from 'path';
import { atomicWrite, safeResolve } from '../../../lib/fs.js';
import { paths } from '../../../config/paths.js';
import { logger } from '../../../lib/logger.js';
import type { ServiceName } from './endpoints.js';

export type CheckStatus = 'in_progress' | 'completed' | 'failed';
export type LogKind = 'info' | 'error' | 'success';

export interface CheckLogEntry {
  time: number;
  service?: ServiceName;
  type: LogKind;
  message: string;
}

export interface CheckLog {
  id: string;
  status: CheckStatus;
  startTime: number;
  endTime?: number;
  logs: CheckLogEntry[];
  result?: Record<ServiceName, { accessible: boolean; url: string; latencyMs?: number }>;
}

const ID_REGEX = /^[a-zA-Z0-9._-]+$/;
const MAX_IN_MEMORY = 10;

const inMemory = new Map<string, CheckLog>();

// Resolved lazily so tests can override the directory via `__setDirForTests`.
let dirOverride: string | null = null;
function currentDir(): string {
  return dirOverride ?? paths.networkCheckDir;
}

export function isValidId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && ID_REGEX.test(id);
}

export function createLog(id: string): CheckLog {
  const log: CheckLog = {
    id,
    status: 'in_progress',
    startTime: Date.now(),
    logs: [],
  };
  inMemory.set(id, log);
  evict();
  persist(log);
  return log;
}

export function appendEntry(
  id: string,
  message: string,
  type: LogKind = 'info',
  service?: ServiceName,
): void {
  const log = inMemory.get(id);
  if (!log) return;
  log.logs.push({ time: Date.now(), message, type, service });
  persist(log);
}

export function completeLog(id: string, result: CheckLog['result']): void {
  const log = inMemory.get(id);
  if (!log) return;
  log.status = 'completed';
  log.endTime = Date.now();
  log.result = result;
  persist(log);
}

export function failLog(id: string, reason: string): void {
  const log = inMemory.get(id);
  if (!log) return;
  log.status = 'failed';
  log.endTime = Date.now();
  log.logs.push({ time: Date.now(), message: reason, type: 'error' });
  persist(log);
}

export function getLog(id: string): CheckLog | null {
  if (!isValidId(id)) return null;
  const mem = inMemory.get(id);
  if (mem) return mem;
  return readFromDisk(id);
}

function evict(): void {
  if (inMemory.size <= MAX_IN_MEMORY) return;
  const first = inMemory.keys().next();
  if (!first.done) inMemory.delete(first.value);
}

function fileFor(id: string): string {
  // Re-check id shape here even though createLog already validates the id;
  // safeResolve provides the belt-and-braces guard against future misuse.
  if (!isValidId(id)) throw new Error('invalid log id');
  return safeResolve(currentDir(), `${id}.json`);
}

function persist(log: CheckLog): void {
  try {
    fs.mkdirSync(currentDir(), { recursive: true, mode: 0o700 });
    atomicWrite(fileFor(log.id), JSON.stringify(log, null, 2));
  } catch (err) {
    logger.warn('networkChecker: persist failed', { id: log.id, error: String(err) });
  }
}

function readFromDisk(id: string): CheckLog | null {
  try {
    const p = fileFor(id);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as CheckLog;
    return parsed;
  } catch {
    return null;
  }
}

// ---- Test hooks ----

/** Test-only: wipe the in-memory cache between runs. */
export function __resetForTests(): void {
  inMemory.clear();
}

/** Test-only: override the log dir so tests write to a tmp path. */
export function __setDirForTests(dir: string | null): void {
  dirOverride = dir ? path.resolve(dir) : null;
}
