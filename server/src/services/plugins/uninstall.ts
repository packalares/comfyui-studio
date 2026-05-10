// Plugin uninstall/disable/enable, version switch, and ComfyUI restart hook.
// All fs operations use safeResolve to prevent path-traversal. All subprocess
// calls flow through lib/exec.run (via install.ts step helpers).

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import * as history from './history.js';
import * as progress from './history.js';
import * as cache from './cache.js';
import {
  ensurePluginDirs,
  findDisabledPluginDir,
  findEnabledPluginDir,
  getDisabledPluginPath,
  getEnabledPluginPath,
  getPluginsRoot,
} from './locations.js';
import {
  applyGithubProxy,
  validatePluginUrl,
  gitClone,
  gitCheckoutVersion,
  pipInstallRequirements,
  removeBackup,
  removePluginDir,
  runInstallScript,
  backupPluginDir,
  type LogFn,
} from './install.js';
import { getProcessService } from '../comfyui/process.js';

// ---- ComfyUI restart hook ----
// Shared by install + uninstall. Failures are logged but never thrown:
// a restart failure must not roll back a successful install/uninstall.

export async function triggerRestart(reason: string): Promise<void> {
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

// ---- Shared task helpers ----

function log(taskId: string, message: string): void {
  history.appendLog(taskId, message);
  progress.addLog(taskId, message);
  logger.info(`[plugin op ${taskId}] ${message}`);
}

function fail(taskId: string, message: string): void {
  history.updateHistoryItem(taskId, {
    endTime: Date.now(), status: 'failed', result: message,
  });
  progress.completeTask(taskId, false, message);
}

function succeed(taskId: string, message: string): void {
  history.updateHistoryItem(taskId, {
    endTime: Date.now(), status: 'success', result: message,
  });
  progress.completeTask(taskId, true, message);
}

// ---- Uninstall ----

async function uninstallTask(taskId: string, pluginId: string): Promise<void> {
  try {
    log(taskId, 'Preparing uninstall');
    // Case-insensitive lookup so PascalCase on-disk dirs (older Manager
    // installs) match against Studio's lowercase pluginId.
    const target = findEnabledPluginDir(pluginId) ?? findDisabledPluginDir(pluginId);
    if (!target) throw new Error('Plugin directory not found');
    log(taskId, `Removing ${target}`);
    await fs.promises.rm(target, { recursive: true, force: true });
    succeed(taskId, `Uninstalled ${pluginId}`);
    cache.clearPluginCache(pluginId);
    cache.refreshInstalledPlugins();
    bus.emit('plugin:removed', { pluginId });
    await triggerRestart(`plugin uninstall: ${pluginId}`);
  } catch (err) {
    fail(taskId, err instanceof Error ? err.message : String(err));
  }
}

export async function uninstallPlugin(pluginId: string): Promise<string> {
  if (!getPluginsRoot()) throw new Error('Plugin root not configured');
  const taskId = randomUUID();
  history.addHistoryItem(taskId, pluginId, 'uninstall');
  progress.createTask(taskId, pluginId, 'uninstall');
  void uninstallTask(taskId, pluginId);
  return taskId;
}

// ---- Disable ----

async function disableTask(taskId: string, pluginId: string): Promise<void> {
  try {
    log(taskId, 'Preparing disable');
    ensurePluginDirs();
    // Source: case-insensitive lookup so PascalCase on-disk dirs match.
    // Destination: same basename so re-enable later finds the same on-disk casing.
    const enabled = findEnabledPluginDir(pluginId);
    if (!enabled) throw new Error('Plugin is not in the enabled directory');
    const disabledRoot = path.dirname(getDisabledPluginPath(pluginId));
    const disabled = path.join(disabledRoot, path.basename(enabled));
    if (fs.existsSync(disabled)) {
      log(taskId, 'Deleting stale disabled copy');
      await fs.promises.rm(disabled, { recursive: true, force: true });
    }
    log(taskId, `Moving plugin to ${disabled}`);
    await fs.promises.rename(enabled, disabled);
    succeed(taskId, `Disabled ${pluginId}`);
    cache.clearPluginCache(pluginId);
    bus.emit('plugin:disabled', { pluginId });
  } catch (err) {
    fail(taskId, err instanceof Error ? err.message : String(err));
  }
}

export async function disablePlugin(pluginId: string): Promise<string> {
  if (!getPluginsRoot()) throw new Error('Plugin root not configured');
  const taskId = randomUUID();
  history.addHistoryItem(taskId, pluginId, 'disable');
  progress.createTask(taskId, pluginId, 'disable');
  void disableTask(taskId, pluginId);
  return taskId;
}

// ---- Enable ----

async function enableTask(taskId: string, pluginId: string): Promise<void> {
  try {
    log(taskId, 'Preparing enable');
    // Source: case-insensitive lookup so PascalCase on-disk dirs in .disabled
    // match against Studio's lowercase pluginId. Destination: preserve the
    // source's basename so Python imports + Manager tracking stay stable.
    const disabled = findDisabledPluginDir(pluginId);
    if (!disabled) throw new Error('Plugin is not in the disabled directory');
    const enabledRoot = path.dirname(getEnabledPluginPath(pluginId));
    const enabled = path.join(enabledRoot, path.basename(disabled));
    if (fs.existsSync(enabled)) {
      log(taskId, 'Deleting stale enabled copy');
      await fs.promises.rm(enabled, { recursive: true, force: true });
    }
    log(taskId, `Moving plugin to ${enabled}`);
    await fs.promises.rename(disabled, enabled);
    succeed(taskId, `Enabled ${pluginId}`);
    cache.clearPluginCache(pluginId);
    bus.emit('plugin:enabled', { pluginId });
  } catch (err) {
    fail(taskId, err instanceof Error ? err.message : String(err));
  }
}

export async function enablePlugin(pluginId: string): Promise<string> {
  if (!getPluginsRoot()) throw new Error('Plugin root not configured');
  const taskId = randomUUID();
  history.addHistoryItem(taskId, pluginId, 'enable');
  progress.createTask(taskId, pluginId, 'enable');
  void enableTask(taskId, pluginId);
  return taskId;
}

// ---- Switch version ----
//
// Reuses install.ts step helpers (gitClone, pipInstallRequirements, etc.).
// The launcher's "release zip download" path is intentionally not ported:
// Studio uses git-clone for every version switch.

export interface TargetVersion {
  id?: string;
  version?: string;
  downloadUrl?: string;
  deprecated?: boolean;
  status?: string;
}

function makeSwitchLog(taskId: string): LogFn {
  return (msg: string) => {
    history.appendLog(taskId, msg);
    progress.addLog(taskId, msg);
    logger.info(`[plugin switch ${taskId}] ${msg}`);
  };
}

function failSwitch(taskId: string, message: string): void {
  history.updateHistoryItem(taskId, {
    endTime: Date.now(), status: 'failed', result: `Switch failed: ${message}`,
  });
  progress.completeTask(taskId, false, `Switch failed: ${message}`);
}

function succeedSwitch(taskId: string, message: string): void {
  history.updateHistoryItem(taskId, {
    endTime: Date.now(), status: 'success', result: message,
  });
  progress.completeTask(taskId, true, message);
}

async function runSwitchTask(
  taskId: string,
  pluginId: string,
  repositoryUrl: string,
  targetVersion: TargetVersion,
  proxy: string,
): Promise<void> {
  const emit = makeSwitchLog(taskId);
  if (targetVersion.deprecated || targetVersion.status === 'NodeVersionStatusBanned') {
    failSwitch(taskId, 'Target version is deprecated or banned');
    return;
  }
  const validation = validatePluginUrl(repositoryUrl);
  if (!validation.ok || !validation.normalized) {
    failSwitch(taskId, validation.error || 'Invalid repository URL');
    return;
  }
  const targetDir = getEnabledPluginPath(pluginId);
  const backup = backupPluginDir(targetDir, emit);
  try {
    const cloneUrl = applyGithubProxy(validation.normalized, proxy);
    await gitClone(cloneUrl, targetDir, undefined, emit);
    if (targetVersion.version) {
      try { await gitCheckoutVersion(targetDir, targetVersion.version, emit); }
      catch (err) { emit(`Checkout failed (continuing with default branch): ${err instanceof Error ? err.message : String(err)}`); }
    }
    await pipInstallRequirements(targetDir, emit);
    await runInstallScript(targetDir, emit);
    await removeBackup(backup, emit);
    succeedSwitch(taskId, `Switched to ${targetVersion.version || 'new version'}`);
    cache.clearPluginCache(pluginId);
    cache.refreshInstalledPlugins();
    await triggerRestart(`plugin switch-version: ${pluginId}`);
  } catch (err) {
    try {
      if (fs.existsSync(targetDir)) await removePluginDir(targetDir);
      if (backup && fs.existsSync(backup)) fs.renameSync(backup, targetDir);
    } catch (restoreErr) {
      emit(`Restore failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
    }
    failSwitch(taskId, err instanceof Error ? err.message : String(err));
    cache.refreshInstalledPlugins();
  }
}

export function switchPluginVersion(
  pluginId: string,
  repositoryUrl: string,
  targetVersion: TargetVersion,
  proxy: string,
): string {
  if (!getPluginsRoot()) throw new Error('Plugin root not configured');
  const taskId = randomUUID();
  history.addHistoryItem(taskId, pluginId, 'switch-version', proxy);
  progress.createTask(taskId, pluginId, 'switch-version', proxy);
  void runSwitchTask(taskId, pluginId, repositoryUrl, targetVersion, proxy);
  return taskId;
}
