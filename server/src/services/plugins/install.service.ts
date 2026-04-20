// Plugin install orchestrator. Ports launcher's `plugin/install.ts` with all
// shell exec replaced by `lib/exec.run`, all URLs validated, every
// subprocess argv-only. Install is fire-and-forget: the caller gets a
// taskId immediately and polls /plugins/progress/:taskId.

import { randomUUID } from 'crypto';
import fs from 'fs';
import { logger } from '../../lib/logger.js';
import * as liveSettings from '../systemLauncher/liveSettings.js';
import * as history from './history.service.js';
import * as progress from './progress.service.js';
import * as cache from './cache.service.js';
import { getEnabledPluginPath, getPluginsRoot } from './locations.js';
import {
  applyGithubProxy,
  parseGithubOwnerRepo,
  validatePluginUrl,
} from './install.urlValidation.js';
import {
  backupPluginDir, gitClone, gitCheckoutVersion,
  pipInstallRequirements, removeBackup, removePluginDir, runInstallScript,
  type LogFn,
} from './install.steps.js';
import { triggerRestart } from './restart.js';

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

function log(taskId: string, message: string): LogFn {
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
  const emit = log(taskId, '');
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

/** Public: install from catalog entry. Returns taskId. Runs async. */
export async function installPlugin(
  pluginId: string,
  pluginInfo: CatalogPluginRef,
  clientProxy: string | undefined,
): Promise<string> {
  if (!getPluginsRoot()) throw new Error('Plugin root not configured');
  const taskId = randomUUID();
  const proxy = resolveProxy(clientProxy);
  history.addHistoryItem(taskId, pluginId, 'install', proxy);
  progress.createTask(taskId, pluginId, 'install', proxy);
  void runInstallTask(taskId, pluginId, () => installFromCatalog(taskId, pluginId, pluginInfo, proxy));
  return taskId;
}

/** Public: install a custom GitHub URL. Returns taskId. */
export async function installCustomPlugin(
  githubUrl: string,
  branch: string = 'main',
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
  const proxy = resolveProxy(clientProxy);
  history.addHistoryItem(taskId, pluginId, 'install', proxy);
  progress.createTask(taskId, pluginId, 'install', proxy);
  const normalized = validation.normalized;
  void runInstallTask(taskId, pluginId, async () => {
    const emit = log(taskId, '');
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

/** Public: used by resource-packs to install by URL while streaming progress. */
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
  const targetDir = getEnabledPluginPath(pluginId);
  const emit: LogFn = (msg) => logger.info(`[plugin install ${operationId}] ${msg}`);
  const backup = backupPluginDir(targetDir, emit);
  try {
    const cloneUrl = applyGithubProxy(validation.normalized, resolveProxy(undefined));
    onProgress({ progress: 20, status: 'downloading' });
    await gitClone(cloneUrl, targetDir, branch || 'main', emit);
    onProgress({ progress: 60, status: 'installing' });
    await pipInstallRequirements(targetDir, emit);
    await runInstallScript(targetDir, emit);
    await removeBackup(backup, emit);
    onProgress({ progress: 100, status: 'completed' });
  } catch (err) {
    onProgress({ progress: 0, status: 'error', error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

function resolveProxy(clientProxy: string | undefined): string {
  const sys = liveSettings.getGithubProxy();
  if (sys && sys !== 'https://github.com') return sys;
  return clientProxy || '';
}

async function runInstallTask(taskId: string, pluginId: string, op: () => Promise<void>): Promise<void> {
  try {
    await op();
    const msg = `Installation complete for ${pluginId}`;
    succeed(taskId, msg);
    cache.clearPluginCache(pluginId);
    cache.refreshInstalledPlugins();
    await triggerRestart(`plugin install: ${pluginId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(taskId, msg);
    cache.refreshInstalledPlugins();
  }
}
