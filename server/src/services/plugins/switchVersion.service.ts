// Plugin version-switch. Reuses install.steps helpers to clone + checkout
// the chosen version atop a backup of the current install. Ported from
// launcher's `plugin/install.ts::switchPluginVersion` — with the shell-exec
// and download-via-superagent paths replaced by `lib/exec.run` only. The
// launcher's "release zip download" path is intentionally NOT ported here:
// Studio defers to git-clone for every version switch, which matches the
// behaviour when the release-URL branch was absent in the source data.

import { randomUUID } from 'crypto';
import fs from 'fs';
import { logger } from '../../lib/logger.js';
import * as history from './history.service.js';
import * as progress from './progress.service.js';
import * as cache from './cache.service.js';
import { getEnabledPluginPath, getPluginsRoot } from './locations.js';
import {
  applyGithubProxy,
  validatePluginUrl,
} from './install.urlValidation.js';
import {
  backupPluginDir, gitClone, gitCheckoutVersion,
  pipInstallRequirements, removeBackup, removePluginDir, runInstallScript,
  type LogFn,
} from './install.steps.js';
import { triggerRestart } from './restart.js';

export interface TargetVersion {
  id?: string;
  version?: string;
  downloadUrl?: string;
  deprecated?: boolean;
  status?: string;
}

function log(taskId: string): LogFn {
  return (msg: string) => {
    history.appendLog(taskId, msg);
    progress.addLog(taskId, msg);
    logger.info(`[plugin switch ${taskId}] ${msg}`);
  };
}

function fail(taskId: string, message: string): void {
  history.updateHistoryItem(taskId, {
    endTime: Date.now(), status: 'failed', result: `Switch failed: ${message}`,
  });
  progress.completeTask(taskId, false, `Switch failed: ${message}`);
}

function succeed(taskId: string, message: string): void {
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
  const emit = log(taskId);
  if (targetVersion.deprecated || targetVersion.status === 'NodeVersionStatusBanned') {
    fail(taskId, 'Target version is deprecated or banned');
    return;
  }
  const validation = validatePluginUrl(repositoryUrl);
  if (!validation.ok || !validation.normalized) {
    fail(taskId, validation.error || 'Invalid repository URL');
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
    succeed(taskId, `Switched to ${targetVersion.version || 'new version'}`);
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
    fail(taskId, err instanceof Error ? err.message : String(err));
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
