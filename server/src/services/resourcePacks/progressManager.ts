// Per-pack install progress manager. Ports launcher's
// `resourcepacks/progress-manager.ts` with Chinese translated to English.

import {
  InstallStatus,
  type ResourcePack,
  type ResourceInstallStatus,
  type ResourcePackInstallProgress,
} from '../../contracts/resourcePacks.contract.js';
import { logger } from '../../lib/logger.js';

const state = new Map<string, ResourcePackInstallProgress>();

export function createProgress(pack: ResourcePack, taskId: string): ResourcePackInstallProgress {
  const progress: ResourcePackInstallProgress = {
    packId: pack.id,
    packName: pack.name,
    taskId,
    status: InstallStatus.PENDING,
    currentResourceIndex: 0,
    totalResources: pack.resources.length,
    progress: 0,
    startTime: Date.now(),
    resourceStatuses: pack.resources.map((resource): ResourceInstallStatus => ({
      resourceId: resource.id,
      resourceName: resource.name,
      resourceType: resource.type,
      status: InstallStatus.PENDING,
      progress: 0,
    })),
  };
  state.set(taskId, progress);
  logger.info('pack progress created', { name: pack.name, taskId });
  return progress;
}

export function getProgress(taskId: string): ResourcePackInstallProgress | undefined {
  return state.get(taskId);
}

export function updateOverallProgress(taskId: string, _currentIndex: number, totalResources: number): void {
  const p = state.get(taskId);
  if (!p) return;
  const list = p.resourceStatuses;
  const count = list.length > 0 ? list.length : Math.max(1, totalResources || 0);
  const sum = list.reduce((acc, r) => acc + Math.max(0, Math.min(100, Number(r.progress || 0))), 0);
  const average = Math.floor(sum / count);
  const completed = list.filter((r) => r.status === InstallStatus.COMPLETED).length;
  p.currentResourceIndex = Math.max(0, completed - 1);
  p.totalResources = list.length || totalResources;
  p.progress = average;
}

export function updateResourceStatus(
  taskId: string,
  resourceId: string,
  status: InstallStatus,
  progress: number = 0,
  error?: string,
): void {
  const p = state.get(taskId);
  if (!p) return;
  const rs = p.resourceStatuses.find((r) => r.resourceId === resourceId);
  if (!rs) return;
  rs.status = status;
  rs.progress = progress;
  if (error) rs.error = error;
  if (status === InstallStatus.DOWNLOADING || status === InstallStatus.INSTALLING) {
    rs.startTime = rs.startTime || Date.now();
  }
  if (status === InstallStatus.COMPLETED || status === InstallStatus.ERROR || status === InstallStatus.CANCELED) {
    rs.endTime = Date.now();
  }
  updateOverallProgress(taskId, 0, p.totalResources);
}

export function updateTaskStatus(taskId: string, status: InstallStatus, error?: string): void {
  const p = state.get(taskId);
  if (!p) return;
  p.status = status;
  if (error) p.error = error;
  if (status === InstallStatus.COMPLETED || status === InstallStatus.ERROR || status === InstallStatus.CANCELED) {
    p.endTime = Date.now();
  }
}

export function cancelTask(taskId: string): boolean {
  const p = state.get(taskId);
  if (!p) return false;
  p.canceled = true;
  p.status = InstallStatus.CANCELED;
  p.endTime = Date.now();
  for (const rs of p.resourceStatuses) {
    if (rs.status !== InstallStatus.COMPLETED
      && rs.status !== InstallStatus.ERROR
      && rs.status !== InstallStatus.SKIPPED) {
      rs.status = InstallStatus.CANCELED;
      rs.endTime = Date.now();
    }
  }
  logger.info('pack task canceled', { taskId });
  return true;
}

export function isTaskCanceled(taskId: string): boolean {
  return Boolean(state.get(taskId)?.canceled);
}

export function hasActiveTask(taskId: string): boolean {
  const p = state.get(taskId);
  return Boolean(p && (p.status === InstallStatus.DOWNLOADING || p.status === InstallStatus.INSTALLING));
}

export function cleanupCompletedTasks(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const drop: string[] = [];
  for (const [taskId, progress] of state.entries()) {
    if (progress.endTime && progress.endTime < oneHourAgo
      && (progress.status === InstallStatus.COMPLETED
        || progress.status === InstallStatus.ERROR
        || progress.status === InstallStatus.CANCELED)) {
      drop.push(taskId);
    }
  }
  for (const id of drop) state.delete(id);
}

export function getActiveTaskIds(): string[] {
  const out: string[] = [];
  for (const [taskId, p] of state.entries()) {
    if (p.status === InstallStatus.PENDING
      || p.status === InstallStatus.DOWNLOADING
      || p.status === InstallStatus.INSTALLING) {
      out.push(taskId);
    }
  }
  return out;
}
