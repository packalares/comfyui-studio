// Plugin uninstall / disable / enable. Ports launcher's `plugin/uninstall.ts`
// with all shell exec replaced by `fs.promises.rm`. Every path is filtered
// through `safeResolve` so a malicious pluginId cannot escape the plugin root.

import { randomUUID } from 'crypto';
import fs from 'fs';
import { logger } from '../../lib/logger.js';
import * as history from './history.service.js';
import * as progress from './progress.service.js';
import * as cache from './cache.service.js';
import {
  ensurePluginDirs,
  getDisabledPluginPath,
  getEnabledPluginPath,
  getPluginsRoot,
} from './locations.js';
import { triggerRestart } from './restart.js';

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

/** Returns both candidate paths so the caller can probe whichever exists. */
function bothPaths(pluginId: string): { enabled: string; disabled: string } {
  return { enabled: getEnabledPluginPath(pluginId), disabled: getDisabledPluginPath(pluginId) };
}

async function uninstallTask(taskId: string, pluginId: string): Promise<void> {
  try {
    log(taskId, 'Preparing uninstall');
    const { enabled, disabled } = bothPaths(pluginId);
    let target: string | null = null;
    if (fs.existsSync(enabled)) target = enabled;
    else if (fs.existsSync(disabled)) target = disabled;
    if (!target) throw new Error('Plugin directory not found');
    log(taskId, `Removing ${target}`);
    await fs.promises.rm(target, { recursive: true, force: true });
    succeed(taskId, `Uninstalled ${pluginId}`);
    cache.clearPluginCache(pluginId);
    cache.refreshInstalledPlugins();
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

async function disableTask(taskId: string, pluginId: string): Promise<void> {
  try {
    log(taskId, 'Preparing disable');
    ensurePluginDirs();
    const { enabled, disabled } = bothPaths(pluginId);
    if (!fs.existsSync(enabled)) throw new Error('Plugin is not in the enabled directory');
    if (fs.existsSync(disabled)) {
      log(taskId, 'Deleting stale disabled copy');
      await fs.promises.rm(disabled, { recursive: true, force: true });
    }
    log(taskId, `Moving plugin to ${disabled}`);
    await fs.promises.rename(enabled, disabled);
    succeed(taskId, `Disabled ${pluginId}`);
    cache.clearPluginCache(pluginId);
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

async function enableTask(taskId: string, pluginId: string): Promise<void> {
  try {
    log(taskId, 'Preparing enable');
    const { enabled, disabled } = bothPaths(pluginId);
    if (!fs.existsSync(disabled)) throw new Error('Plugin is not in the disabled directory');
    if (fs.existsSync(enabled)) {
      log(taskId, 'Deleting stale enabled copy');
      await fs.promises.rm(enabled, { recursive: true, force: true });
    }
    log(taskId, `Moving plugin to ${enabled}`);
    await fs.promises.rename(disabled, enabled);
    succeed(taskId, `Enabled ${pluginId}`);
    cache.clearPluginCache(pluginId);
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

// ---- Switch version: stored in install.service for proximity.
