// Plugin install orchestrator + per-step helpers + URL allow-list.
// Install is fire-and-forget: the caller gets a taskId and polls
// /plugins/progress/:taskId. Every subprocess call flows through
// `lib/exec.run` (argv only, no shell).

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import * as liveSettings from '../settings/network.js';
import { hostIsPrivate } from '../../lib/security.js';
import { getPluginTrustedHosts } from '../settings/network.js';
import * as history from './history.js';
import * as progress from './history.js';
import * as cache from './cache.js';
import { getEnabledPluginPath, getPluginsRoot } from './locations.js';
import { getProcessService } from '../comfyui/process.js';
import { canonicalizeSync, repoBasename } from './nodes.js';

// Inline restart hook — avoids a cycle with uninstall.ts (which imports
// install step helpers). Failures are logged but never thrown: a restart
// failure must not roll back a successful install.
async function triggerRestart(reason: string): Promise<void> {
  try {
    const svc = getProcessService();
    const result = await svc.restartComfyUI();
    if (!result.success) {
      logger.warn('comfyui restart returned failure', { reason, error: result.error });
    } else {
      logger.info('comfyui restarted', { reason });
    }
  } catch (err) {
    logger.error('comfyui restart failed', {
      reason,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- URL validation ----
//
// SECURITY: enforces https-only, hostname allow-list, and SSRF-dangerous
// private-IP rejection before any git clone or file fetch.

const BUILTIN_HOSTS = new Set(['github.com', 'gitlab.com', 'huggingface.co', 'www.github.com', 'www.gitlab.com']);

function allowedHosts(): Set<string> {
  const out = new Set<string>(BUILTIN_HOSTS);
  for (const h of getPluginTrustedHosts()) out.add(h);
  return out;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  normalized?: string;
}

export function validatePluginUrl(input: string): ValidationResult {
  if (!input || typeof input !== 'string') return { ok: false, error: 'URL is required' };
  let parsed: URL;
  try { parsed = new URL(input.trim()); }
  catch { return { ok: false, error: 'Invalid URL format' }; }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed' };
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts().has(host)) return { ok: false, error: `Host not allowed: ${host}` };
  if (hostIsPrivate(parsed.toString())) return { ok: false, error: 'Host resolves to a private/loopback range' };
  return { ok: true, normalized: parsed.toString().replace(/\.git\/?$/, '') };
}

/** Validate for the common subset: a GitHub URL with parseable owner/repo. */
export function parseGithubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') };
}

/**
 * Apply a GitHub proxy prefix. Empty / https://github.com means "no proxy",
 * matching launcher's proxy rewrite semantics.
 */
export function applyGithubProxy(githubUrl: string, proxy: string): string {
  const trimmed = (proxy || '').trim();
  if (!trimmed) return githubUrl;
  if (trimmed === 'https://github.com' || trimmed === 'https://github.com/') return githubUrl;
  const withSlash = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  return githubUrl.replace('https://github.com/', withSlash);
}

// ---- Install steps ----

const GIT_CLONE_TIMEOUT_MS = 60_000;
const PIP_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

function python(): string { return env.PYTHON_PATH || 'python3'; }

export type LogFn = (message: string) => void;

/** Clone a URL into `targetDir`. Fails fast on non-zero exit code. */
export async function gitClone(
  url: string,
  targetDir: string,
  branch: string | undefined,
  log: LogFn,
): Promise<void> {
  const args = ['clone'];
  if (branch) args.push('--branch', branch);
  args.push(url, targetDir);
  log(`Executing: git ${args.join(' ')}`);
  const r = await run('git', args, { timeoutMs: GIT_CLONE_TIMEOUT_MS });
  if (r.stdout) log(`git stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`git stderr: ${r.stderr.trim()}`);
  if (r.code !== 0 || r.timedOut) {
    throw new Error(`git clone failed (code=${r.code}${r.timedOut ? ', timeout' : ''})`);
  }
}

/** Run `git fetch --all --tags && git checkout <version>` inside the clone. */
export async function gitCheckoutVersion(
  targetDir: string,
  version: string,
  log: LogFn,
): Promise<void> {
  log(`Checkout: ${version}`);
  const fetchResult = await run('git', ['fetch', '--all', '--tags'], {
    cwd: targetDir,
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
  });
  if (fetchResult.stderr) log(`git fetch stderr: ${fetchResult.stderr.trim()}`);
  const r = await run('git', ['checkout', version], {
    cwd: targetDir,
    timeoutMs: GIT_CLONE_TIMEOUT_MS,
  });
  if (r.stdout) log(`git checkout stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`git checkout stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) throw new Error(`git checkout ${version} failed`);
}

/** Install a plugin's requirements.txt via pip. Called after a successful clone. */
export async function pipInstallRequirements(
  pluginDir: string,
  log: LogFn,
): Promise<void> {
  let reqPath: string;
  try { reqPath = safeResolve(pluginDir, 'requirements.txt'); }
  catch { log('Skipping requirements: path escaped plugin dir'); return; }
  if (!fs.existsSync(reqPath)) { log('No requirements.txt'); return; }
  const args = ['-m', 'pip', 'install', '--user', '-r', reqPath, '--no-cache-dir'];
  log(`Executing: ${python()} ${args.join(' ')}`);
  const r = await run(python(), args, { timeoutMs: PIP_INSTALL_TIMEOUT_MS });
  if (r.stdout) log(`pip stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`pip stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) log(`pip install failed (code=${r.code}), continuing`);
}

/** Run `python install.py` inside the plugin dir when present. */
export async function runInstallScript(pluginDir: string, log: LogFn): Promise<void> {
  let scriptPath: string;
  try { scriptPath = safeResolve(pluginDir, 'install.py'); }
  catch { return; }
  if (!fs.existsSync(scriptPath)) { log('No install.py'); return; }
  log(`Executing: ${python()} ${scriptPath}`);
  const r = await run(python(), [scriptPath], {
    cwd: pluginDir,
    timeoutMs: SCRIPT_TIMEOUT_MS,
  });
  if (r.stdout) log(`install.py stdout: ${r.stdout.trim()}`);
  if (r.stderr) log(`install.py stderr: ${r.stderr.trim()}`);
  if (r.code !== 0) log(`install.py failed (code=${r.code}), continuing`);
}

/** Remove a plugin dir recursively via fs.promises.rm. Never through shell. */
export async function removePluginDir(pluginDir: string): Promise<void> {
  await fs.promises.rm(pluginDir, { recursive: true, force: true });
}

/** Rename the existing plugin dir to `<dir>_backup_<ts>` so install can retry. */
export function backupPluginDir(pluginDir: string, log: LogFn): string | null {
  if (!fs.existsSync(pluginDir)) return null;
  const backup = `${pluginDir}_backup_${Date.now()}`;
  fs.renameSync(pluginDir, backup);
  log(`Backup: ${path.basename(backup)}`);
  return backup;
}

/** Best-effort cleanup of a backup directory once install has succeeded. */
export async function removeBackup(backupDir: string | null, log: LogFn): Promise<void> {
  if (!backupDir) return;
  try { await fs.promises.rm(backupDir, { recursive: true, force: true }); }
  catch (err) {
    logger.warn('plugin backup cleanup failed', { message: err instanceof Error ? err.message : String(err) });
    log(`Backup cleanup failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- Install orchestrator ----

export interface CatalogPluginRef {
  id: string;
  repository?: string;
  github?: string;
  latest_version?: unknown;
  versions?: unknown[];
  status?: string;
  deprecated?: boolean;
  install_type?: string;
}

function latestVersionOf(info: CatalogPluginRef): {
  version?: string; downloadUrl?: string; deprecated?: boolean; status?: string;
} | undefined {
  const raw = info.latest_version;
  if (!raw || typeof raw !== 'object') return undefined;
  return raw as { version?: string; downloadUrl?: string; deprecated?: boolean; status?: string };
}

function makeLog(taskId: string): LogFn {
  return (msg: string) => {
    history.appendLog(taskId, msg);
    progress.addLog(taskId, msg);
    logger.info(`[plugin install ${taskId}] ${msg}`);
  };
}

function fail(taskId: string, message: string): void {
  history.updateHistoryItem(taskId, {
    endTime: Date.now(), status: 'failed', result: `Install failed: ${message}`,
  });
  progress.completeTask(taskId, false, `Install failed: ${message}`);
}

function succeed(taskId: string, message: string): void {
  history.updateHistoryItem(taskId, {
    endTime: Date.now(), status: 'success', result: message,
  });
  progress.completeTask(taskId, true, message);
}

// In-flight install mutex keyed by canonical plugin id. Two parallel install
// requests for the same plugin collapse to ONE git-clone task; the second
// caller receives the in-flight taskId. Cleared in runInstallTask's finally
// block so a completed install (or failure) frees the slot for retry.
const installInFlight = new Map<string, string>();

function inflightKey(pluginRef: string): string {
  return repoBasename(canonicalizeSync(pluginRef));
}

function reserveInflight(pluginRef: string, taskId: string): { existing?: string; key: string } {
  const key = inflightKey(pluginRef);
  if (!key) return { key };
  const existing = installInFlight.get(key);
  if (existing) return { existing, key };
  installInFlight.set(key, taskId);
  return { key };
}

function releaseInflight(key: string): void {
  if (key) installInFlight.delete(key);
}

function pluginIsBlocked(info: CatalogPluginRef): string | null {
  if (info.deprecated || info.status === 'NodeStatusBanned') return 'Plugin is deprecated or banned';
  const lv = latestVersionOf(info);
  if (lv && (lv.deprecated || lv.status === 'NodeVersionStatusBanned')) {
    return 'Latest version is deprecated or banned';
  }
  return null;
}

async function installFromCatalog(
  taskId: string,
  pluginId: string,
  pluginInfo: CatalogPluginRef,
  githubProxy: string,
): Promise<void> {
  const emit = makeLog(taskId);
  const blocked = pluginIsBlocked(pluginInfo);
  if (blocked) throw new Error(blocked);
  const targetDir = getEnabledPluginPath(pluginId);
  const backup = backupPluginDir(targetDir, emit);
  try {
    const rawUrl = pluginInfo.repository || pluginInfo.github || '';
    const normalized = normalizeRepositoryUrl(rawUrl);
    const validation = validatePluginUrl(normalized);
    if (!validation.ok || !validation.normalized) {
      throw new Error(validation.error || 'Invalid repository URL');
    }
    const cloneUrl = applyGithubProxy(validation.normalized, githubProxy);
    await gitClone(cloneUrl, targetDir, undefined, emit);
    const version = latestVersionOf(pluginInfo)?.version;
    if (version) { try { await gitCheckoutVersion(targetDir, version, emit); } catch { /* ignore */ } }
    await pipInstallRequirements(targetDir, emit);
    await runInstallScript(targetDir, emit);
    await removeBackup(backup, emit);
  } catch (err) {
    // Restore backup on failure if present.
    try {
      if (fs.existsSync(targetDir)) await removePluginDir(targetDir);
      if (backup && fs.existsSync(backup)) fs.renameSync(backup, targetDir);
    } catch (restoreErr) {
      emit(`Restore failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
    }
    throw err;
  }
}

function normalizeRepositoryUrl(url: string): string {
  return url.replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

/** Public: install from catalog entry. Returns taskId. Runs async.
 *
 *  Idempotent: a second concurrent call for the same plugin returns the
 *  original in-flight taskId rather than spawning a second git clone. */
export async function installPlugin(
  pluginId: string,
  pluginInfo: CatalogPluginRef,
  clientProxy: string | undefined,
): Promise<string> {
  if (!getPluginsRoot()) throw new Error('Plugin root not configured');
  const taskId = randomUUID();
  const reservation = reserveInflight(pluginId, taskId);
  if (reservation.existing) return reservation.existing;
  const proxy = resolveProxy(clientProxy);
  history.addHistoryItem(taskId, pluginId, 'install', proxy);
  progress.createTask(taskId, pluginId, 'install', proxy);
  void runInstallTask(taskId, pluginId, reservation.key,
    () => installFromCatalog(taskId, pluginId, pluginInfo, proxy));
  return taskId;
}

/** Public: install a custom GitHub URL. Returns taskId.
 *
 *  When `branch` is undefined, `gitClone` omits `--branch` and git uses the
 *  remote's default HEAD — auto-detects `master` vs `main` vs anything else.
 *  Forcing `'main'` here would break older repos whose default is `master`. */
export async function installCustomPlugin(
  githubUrl: string,
  branch: string | undefined,
  clientProxy: string | undefined,
): Promise<{ taskId: string; pluginId: string }> {
  if (!getPluginsRoot()) throw new Error('Plugin root not configured');
  const validation = validatePluginUrl(githubUrl);
  if (!validation.ok || !validation.normalized) {
    throw new Error(validation.error || 'Invalid GitHub URL');
  }
  const ownerRepo = parseGithubOwnerRepo(validation.normalized);
  const pluginId = ownerRepo?.repo ?? (randomUUID().slice(0, 8));
  const taskId = randomUUID();
  const refKey = ownerRepo
    ? `${ownerRepo.owner}/${ownerRepo.repo}`
    : pluginId;
  const reservation = reserveInflight(refKey, taskId);
  if (reservation.existing) return { taskId: reservation.existing, pluginId };
  const proxy = resolveProxy(clientProxy);
  history.addHistoryItem(taskId, pluginId, 'install', proxy);
  progress.createTask(taskId, pluginId, 'install', proxy);
  const normalized = validation.normalized;
  void runInstallTask(taskId, pluginId, reservation.key, async () => {
    const emit = makeLog(taskId);
    const targetDir = getEnabledPluginPath(pluginId);
    const backup = backupPluginDir(targetDir, emit);
    try {
      const cloneUrl = applyGithubProxy(normalized, proxy);
      await gitClone(cloneUrl, targetDir, branch, emit);
      await pipInstallRequirements(targetDir, emit);
      await runInstallScript(targetDir, emit);
      await removeBackup(backup, emit);
    } catch (err) {
      try {
        if (fs.existsSync(targetDir)) await removePluginDir(targetDir);
        if (backup && fs.existsSync(backup)) fs.renameSync(backup, targetDir);
      } catch { /* ignore */ }
      throw err;
    }
  });
  return { taskId, pluginId };
}

/** Public: used by resource-packs to install by URL while streaming progress.
 *
 *  Mutex-aware: a parallel call for the same canonical plugin id streams the
 *  original task's terminal event but doesn't spawn a second clone. */
export async function installPluginFromUrl(
  githubUrl: string,
  branch: string | undefined,
  onProgress: (p: { progress: number; status: string; error?: string }) => void,
  operationId: string,
): Promise<void> {
  const validation = validatePluginUrl(githubUrl);
  if (!validation.ok || !validation.normalized) {
    onProgress({ progress: 0, status: 'error', error: validation.error || 'Invalid URL' });
    throw new Error(validation.error || 'Invalid URL');
  }
  const ownerRepo = parseGithubOwnerRepo(validation.normalized);
  if (!ownerRepo) throw new Error('Cannot parse GitHub owner/repo');
  const pluginId = ownerRepo.repo;
  const refKey = `${ownerRepo.owner}/${ownerRepo.repo}`;
  const reservation = reserveInflight(refKey, operationId);
  if (reservation.existing) {
    // Concurrent install already running. Emit a terminal event so the caller
    // doesn't hang waiting for a status it will never receive.
    onProgress({ progress: 100, status: 'completed' });
    return;
  }
  const targetDir = getEnabledPluginPath(pluginId);
  const emit: LogFn = (msg) => logger.info(`[plugin install ${operationId}] ${msg}`);
  const backup = backupPluginDir(targetDir, emit);
  try {
    const cloneUrl = applyGithubProxy(validation.normalized, resolveProxy(undefined));
    onProgress({ progress: 20, status: 'downloading' });
    await gitClone(cloneUrl, targetDir, branch, emit);
    onProgress({ progress: 60, status: 'installing' });
    await pipInstallRequirements(targetDir, emit);
    await runInstallScript(targetDir, emit);
    await removeBackup(backup, emit);
    onProgress({ progress: 100, status: 'completed' });
  } catch (err) {
    onProgress({ progress: 0, status: 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    releaseInflight(reservation.key);
  }
}

function resolveProxy(clientProxy: string | undefined): string {
  const sys = liveSettings.getGithubProxy();
  if (sys && sys !== 'https://github.com') return sys;
  return clientProxy || '';
}

async function runInstallTask(
  taskId: string,
  pluginId: string,
  inflightSlotKey: string,
  op: () => Promise<void>,
): Promise<void> {
  try {
    await op();
    const msg = `Installation complete for ${pluginId}`;
    succeed(taskId, msg);
    cache.clearPluginCache(pluginId);
    cache.refreshInstalledPlugins();
    bus.emit('plugin:installed', { pluginId });
    await triggerRestart(`plugin install: ${pluginId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(taskId, msg);
    cache.refreshInstalledPlugins();
  } finally {
    releaseInflight(inflightSlotKey);
    // Drop the task after a grace window so the UI can show the final state
    // but the per-task log buffer doesn't accumulate forever.
    setTimeout(() => progress.removeTask(taskId), 30_000).unref();
  }
}
