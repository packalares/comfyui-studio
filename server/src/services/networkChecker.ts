// Runtime network-reachability probe. Separate from settings/network.ts
// (URL knobs) — this file is the runtime probe that CONSUMES those URLs.
//
// Flow: triggerCheck() returns { checkId, status: 'in_progress' } immediately.
// Caller polls getLog(checkId). Concurrent checks are independent (separate
// ids, separate curl subprocesses) and do not interfere with each other.
//
// Log ids are validated with a tight regex so HTTP callers cannot traverse
// out of the check directory.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { run } from '../lib/exec.js';
import { atomicWrite, safeResolve } from '../lib/fs.js';
import { paths } from '../config/paths.js';
import { logger } from '../lib/logger.js';
import {
  getGithubProxy,
  getPipSource,
  getHfEndpoint,
} from './settings/network.js';

// ---- Connectivity probe ----

// Uses curl rather than a JS HTTP client: curl is present in every ComfyUI
// image the studio ships with; if a future deployment lacks it, the probe
// reports the service as inaccessible rather than throwing.
const CURL_RESPONSE_TIMEOUT_SEC = 5;
const CURL_TOTAL_TIMEOUT_SEC = 10;
// Hard per-subprocess ceiling; tests kill runaway children.
const SUBPROCESS_HARD_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  accessible: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

// Never throws: all failure modes collapse into the negative result.
async function probe(url: string, method: 'HEAD' | 'GET' = 'HEAD'): Promise<ProbeResult> {
  const args = buildCurlArgs(url, method);
  const started = Date.now();
  try {
    const r = await run('curl', args, { timeoutMs: SUBPROCESS_HARD_TIMEOUT_MS });
    const latencyMs = Date.now() - started;
    if (r.timedOut) {
      return { accessible: false, latencyMs, error: 'timeout' };
    }
    if (r.code !== 0) {
      return {
        accessible: false,
        latencyMs,
        error: `curl exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`,
      };
    }
    const status = parseStatus(r.stdout);
    if (status == null) {
      return { accessible: false, latencyMs, error: 'unparseable curl output' };
    }
    return { accessible: status >= 200 && status < 400, status, latencyMs };
  } catch (err) {
    return {
      accessible: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a safe curl argv. Silences progress, caps redirects, prints only the status. */
function buildCurlArgs(url: string, method: 'HEAD' | 'GET'): string[] {
  return [
    method === 'HEAD' ? '-I' : '-sI',
    '-s',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--connect-timeout',
    String(CURL_RESPONSE_TIMEOUT_SEC),
    '--max-time',
    String(CURL_TOTAL_TIMEOUT_SEC),
    '-L',
    '--max-redirs',
    '3',
    url,
  ];
}

function parseStatus(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- Endpoints ----

export type ServiceName = 'github' | 'pip' | 'huggingface';

interface ServiceTarget {
  name: ServiceName;
  label: string;
  url: string;
}

// Reads liveSettings each call so edits via the configurator are picked up
// without a restart.
function buildTargets(): ServiceTarget[] {
  const githubProxy = getGithubProxy();
  const pipSource = getPipSource();
  const hfEndpoint = getHfEndpoint();
  return [
    {
      name: 'github',
      label: 'GitHub',
      url: normaliseGithubTarget(githubProxy) || 'https://github.com/',
    },
    {
      name: 'pip',
      label: 'pip',
      url: pipSource || 'https://pypi.org/simple/',
    },
    {
      name: 'huggingface',
      label: 'HuggingFace',
      url: hfEndpoint || 'https://huggingface.co/',
    },
  ];
}

// Strip paths off a GitHub proxy URL so we only probe the proxy host itself.
// Operators commonly configure a proxy URL that includes a /path segment;
// probing the full URL yields false negatives when the path template expects
// a repo name.
function normaliseGithubTarget(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return raw;
  }
}

// ---- Log persistence ----

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

// Resolved lazily so tests can override the directory via __setDirForTests.
let dirOverride: string | null = null;
function currentDir(): string {
  return dirOverride ?? paths.networkCheckDir;
}

export function isValidId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && ID_REGEX.test(id);
}

export function createLog(id: string): CheckLog {
  const log: CheckLog = { id, status: 'in_progress', startTime: Date.now(), logs: [] };
  inMemory.set(id, log);
  evict();
  persistLog(log);
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
  persistLog(log);
}

export function completeLog(id: string, result: CheckLog['result']): void {
  const log = inMemory.get(id);
  if (!log) return;
  log.status = 'completed';
  log.endTime = Date.now();
  log.result = result;
  persistLog(log);
}

export function failLog(id: string, reason: string): void {
  const log = inMemory.get(id);
  if (!log) return;
  log.status = 'failed';
  log.endTime = Date.now();
  log.logs.push({ time: Date.now(), message: reason, type: 'error' });
  persistLog(log);
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
  // Re-check id shape here; safeResolve provides belt-and-braces against
  // future misuse even though createLog already validates.
  if (!isValidId(id)) throw new Error('invalid log id');
  return safeResolve(currentDir(), `${id}.json`);
}

function persistLog(log: CheckLog): void {
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
    return JSON.parse(raw) as CheckLog;
  } catch {
    return null;
  }
}

// ---- Orchestrator ----

export interface CheckSummary {
  accessible: boolean;
  url: string;
  label: string;
  latencyMs?: number;
  error?: string;
}

export type NetworkStatus = Record<ServiceName, CheckSummary>;

let lastResult: NetworkStatus | null = null;

export interface TriggerResponse {
  checkId: string;
  status: 'in_progress';
}

/** Start a new network check. Returns the check id immediately; caller polls getLog(). */
export function triggerCheck(): TriggerResponse {
  const checkId = randomUUID();
  createLog(checkId);
  appendEntry(checkId, 'Network check started', 'info');
  const targets = buildTargets();
  appendEntry(checkId, `Probing ${targets.length} services`, 'info');
  void runCheck(checkId, targets).catch((err) => {
    failLog(checkId, err instanceof Error ? err.message : String(err));
  });
  return { checkId, status: 'in_progress' };
}

async function runCheck(checkId: string, targets: ServiceTarget[]): Promise<void> {
  const entries = await Promise.all(
    targets.map(async (t) => {
      appendEntry(checkId, `Probing ${t.url}`, 'info', t.name);
      const r = await probe(t.url, 'HEAD');
      logProbeEntry(checkId, t, r);
      return [t.name, toSummary(t, r)] as const;
    }),
  );
  const result = Object.fromEntries(entries) as NetworkStatus;
  lastResult = result;
  completeLog(
    checkId,
    Object.fromEntries(
      entries.map(([k, v]) => [k, { accessible: v.accessible, url: v.url, latencyMs: v.latencyMs }]),
    ) as CheckLog['result'],
  );
  appendEntry(checkId, 'Network check completed', 'success');
}

function logProbeEntry(id: string, t: ServiceTarget, r: ProbeResult): void {
  if (r.accessible) {
    appendEntry(id, `OK ${t.label} status=${r.status ?? '?'} (${r.latencyMs ?? '?'}ms)`, 'success', t.name);
  } else if (r.error) {
    appendEntry(id, `FAIL ${t.label}: ${r.error}`, 'error', t.name);
  } else {
    appendEntry(id, `FAIL ${t.label} status=${r.status ?? '?'}`, 'error', t.name);
  }
}

function toSummary(t: ServiceTarget, r: ProbeResult): CheckSummary {
  return {
    accessible: r.accessible,
    url: t.url,
    label: t.label,
    latencyMs: r.latencyMs,
    error: r.error,
  };
}

export function getLastResult(): NetworkStatus | null {
  return lastResult;
}

// ---- Test hooks ----

/** Test-only: reset state between runs. */
export function __resetForTests(): void {
  lastResult = null;
  inMemory.clear();
}

/** Test-only: override the log dir so tests write to a tmp path. */
export function __setDirForTests(dir: string | null): void {
  dirOverride = dir ? path.resolve(dir) : null;
}
