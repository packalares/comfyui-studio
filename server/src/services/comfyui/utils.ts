// Shared utilities for the ComfyUI lifecycle services.
//
// `isComfyUIRunning` probes ComfyUI's TCP port. The launcher did the same via
// `net.Socket` connect and we preserve the semantics (1s timeout -> false).
// `getUptime` formats a human-readable string in English (launcher emitted
// Chinese units; studio now emits English directly, so `translateUptime` in
// `src/index.ts` becomes a no-op identity).
//
// `getGPUMode` inspects env hints an orchestrator may set
// (CUDA_DEVICE_GPU_MODE_0 / NVSHARE_MANAGED_MEMORY) and defaults to
// 'exclusive' to match launcher behaviour.

import * as net from 'net';
import { env } from '../../config/env.js';

/** Probe the ComfyUI port with a 1s TCP connect. Resolves true if reachable. */
export function isComfyUIRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeoutMs = 1000;
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(env.COMFYUI_PORT, 'localhost');
  });
}

/** Human-readable uptime in English. Returns '0s' for null. */
export function getUptime(startTime: Date | null): string {
  if (!startTime) return '0s';
  const diffMs = Date.now() - startTime.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs}s`;
  if (diffSecs < 3600) {
    const mins = Math.floor(diffSecs / 60);
    const secs = diffSecs % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(diffSecs / 3600);
  const mins = Math.floor((diffSecs % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Resolve the GPU sharing mode using env hints the orchestrator may set.
 * Defaults to `exclusive` when no hint is provided.
 */
export function getGPUMode(): string {
  const cudaGpuMode0 = env.CUDA_DEVICE_GPU_MODE_0;
  if (cudaGpuMode0 === '0') return 'exclusive';
  if (cudaGpuMode0 === '1') return 'memorySlice';
  if (cudaGpuMode0 === '2') return 'timeSlice';
  const nvshareMode = env.NVSHARE_MANAGED_MEMORY;
  if (nvshareMode === '0') return 'independent';
  if (nvshareMode === '1') return 'shared';
  return 'exclusive';
}
