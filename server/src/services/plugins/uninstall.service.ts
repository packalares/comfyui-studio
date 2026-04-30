// Plugin uninstall / disable / enable. Ports launcher's `plugin/uninstall.ts`
// with all shell exec replaced by `fs.promises.rm`. Every path is filtered
// through `safeResolve` so a malicious pluginId cannot escape the plugin root.

import { randomUUID } from 'crypto';
import fs from 'fs';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import * as history from './history.service.js';
import * as progress from './progress.service.js';
import * as cache from './cache.service.js';
import path from 'path';
import {
  ensurePluginDirs,
  findDisabledPluginDir,
  findEnabledPluginDir,
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

async function disableTask(taskId: string, pluginId: string): Promise<void> {
  try {
    log(taskId, 'Preparing disable');
    ensurePluginDirs();
    // Source: case-insensitive lookup so PascalCase on-disk dirs match
    // against Studio's lowercase pluginId. Destination: same basename so
    // re-enable later finds the same on-disk casing.
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

// ---- Switch version: stored in install.service for proximity.
