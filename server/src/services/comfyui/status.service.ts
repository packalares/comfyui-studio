// Aggregate the ComfyUI status response. Composes ProcessService state with
// version lookup + GPU mode detection. Response shape is load-bearing: the
// frontend `LauncherStatus` type and studio's `pollLauncherStatus` consume it.

import { getVersionInfo, getAppVersion } from './version.service.js';
import { getGPUMode, getUptime, isComfyUIRunning } from './utils.js';
import { getProcessService } from './singleton.js';
import type { ComfyUIStatus } from './types.js';

export async function getStatus(): Promise<ComfyUIStatus> {
  const svc = getProcessService();
  const running = await isComfyUIRunning();
  const startTime = svc.getStartTime();
  const uptime = running && startTime ? getUptime(startTime) : null;
  const versions = await getVersionInfo();
  return {
    running,
    pid: svc.getComfyPid(),
    uptime,
    versions: {
      comfyui: versions.comfyui || 'unknown',
      frontend: versions.frontend || 'unknown',
      app: getAppVersion(),
    },
    gpuMode: getGPUMode(),
  };
}
