// Resource-pack install orchestrator. Loops through each resource in a pack,
// calls the matching installer, applies retry, and drives the shared progress
// manager. Ports launcher's `base-controller.startResourcePackInstallation`.

import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  InstallStatus,
  ResourceType,
  type CustomResource, type ModelResource, type PackResource,
  type PluginResource, type ResourcePack, type WorkflowResource,
} from '../../contracts/resourcePacks.contract.js';
import * as progressManager from './progressManager.js';
import { installModelResource } from './modelInstaller.service.js';
import { installPluginResource } from './pluginInstaller.service.js';
import { installWorkflowResource } from './workflowInstaller.service.js';
import { installCustomResource } from './customInstaller.service.js';
import type { OnProgress } from './baseInstaller.js';

const abortControllers = new Map<string, AbortController>();

function startingPercent(taskId: string, resourceId: string): number {
  const existing = progressManager.getProgress(taskId);
  const rs = existing?.resourceStatuses.find((r) => r.resourceId === resourceId);
  return rs?.progress && rs.progress > 0 ? rs.progress : 0;
}

async function dispatchInstall(
  resource: PackResource,
  taskId: string,
  source: string,
  onProgress: OnProgress,
  abortController: AbortController,
): Promise<void> {
  switch (resource.type) {
    case ResourceType.MODEL:
      await installModelResource(resource as ModelResource, taskId, source, onProgress, abortController);
      return;
    case ResourceType.PLUGIN:
      await installPluginResource(resource as PluginResource, taskId, onProgress, abortController);
      return;
    case ResourceType.WORKFLOW:
      await installWorkflowResource(resource as WorkflowResource, taskId, onProgress, abortController);
      return;
    case ResourceType.CUSTOM:
      await installCustomResource(resource as CustomResource, taskId, onProgress, abortController);
      return;
  }
}

async function installOneResource(
  resource: PackResource,
  taskId: string,
  source: string,
  abortController: AbortController,
): Promise<void> {
  const initial = startingPercent(taskId, resource.id);
  progressManager.updateResourceStatus(taskId, resource.id, InstallStatus.DOWNLOADING, initial);
  const onProgress: OnProgress = (status, p, err) => {
    progressManager.updateResourceStatus(taskId, resource.id, status, p, err);
  };
  const attempts = env.RP_RETRY_ATTEMPTS;
  const base = env.RP_RETRY_BASE_DELAY_MS;
  const factor = env.RP_RETRY_BACKOFF;
  const maxDelay = env.RP_RETRY_MAX_DELAY_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    if (abortController.signal.aborted || progressManager.isTaskCanceled(taskId)) {
      progressManager.updateResourceStatus(taskId, resource.id, InstallStatus.CANCELED, initial);
      return;
    }
    try {
      await dispatchInstall(resource, taskId, source, onProgress, abortController);
      return;
    } catch (err) {
      lastError = err;
      if (abortController.signal.aborted || progressManager.isTaskCanceled(taskId)) return;
      if (attempt < attempts) {
        const delay = Math.min(maxDelay, Math.floor(base * Math.pow(factor, attempt)));
        logger.warn('resource install retry', { name: resource.name, attempt, delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  progressManager.updateResourceStatus(taskId, resource.id, InstallStatus.ERROR, 0, msg);
}

export async function startResourcePackInstallation(
  pack: ResourcePack,
  taskId: string,
  source: string,
  selected?: string[],
): Promise<void> {
  const abortController = new AbortController();
  abortControllers.set(taskId, abortController);
  progressManager.updateTaskStatus(taskId, InstallStatus.DOWNLOADING);
  const resources = selected
    ? pack.resources.filter((r) => selected.includes(r.id))
    : pack.resources;
  try {
    for (let i = 0; i < resources.length; i++) {
      if (abortController.signal.aborted || progressManager.isTaskCanceled(taskId)) {
        progressManager.updateTaskStatus(taskId, InstallStatus.CANCELED);
        return;
      }
      await installOneResource(resources[i], taskId, source, abortController);
      progressManager.updateOverallProgress(taskId, i, resources.length);
    }
    progressManager.updateTaskStatus(taskId, InstallStatus.COMPLETED);
  } catch (err) {
    if (abortController.signal.aborted || progressManager.isTaskCanceled(taskId)) {
      progressManager.updateTaskStatus(taskId, InstallStatus.CANCELED);
      return;
    }
    progressManager.updateTaskStatus(
      taskId, InstallStatus.ERROR,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    abortControllers.delete(taskId);
  }
}

export function cancelInstallation(taskId: string): boolean {
  const ok = progressManager.cancelTask(taskId);
  const ac = abortControllers.get(taskId);
  if (ac) ac.abort();
  abortControllers.delete(taskId);
  return ok;
}
