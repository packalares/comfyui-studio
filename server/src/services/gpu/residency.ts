// GPU residency management: track which tenant currently holds VRAM and
// handle the unload-before-switch transitions. Uses existing URL-resolution
// helpers rather than duplicating them.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getComfyUIUrl } from '../comfyui/api.js';
import { getOllamaUrl } from '../settings/index.js';
import { logger } from '../../lib/logger.js';
import type { GpuTenant } from './taskTypes.js';

const execFileAsync = promisify(execFile);

// ---- State ----

let currentTenant: GpuTenant = 'none';

export function getCurrentTenant(): GpuTenant {
  return currentTenant;
}

export function forceSetTenant(tenant: GpuTenant): void {
  currentTenant = tenant;
}

// ---- nvidia-smi availability cache ----
// Avoid re-spawning when nvidia-smi is known missing (avoids 10x/sec spawns).
let nvidiaSmiAvailable: boolean | null = null;

async function checkNvidiaSmiAvailable(): Promise<boolean> {
  if (nvidiaSmiAvailable !== null) return nvidiaSmiAvailable;
  try {
    await execFileAsync('nvidia-smi', ['--version']);
    nvidiaSmiAvailable = true;
  } catch {
    nvidiaSmiAvailable = false;
  }
  return nvidiaSmiAvailable;
}

// ---- Unload helpers ----

export async function unloadOllama(): Promise<void> {
  const baseUrl = getOllamaUrl();
  // Query which models are loaded, then unload each.
  let models: string[] = [];
  try {
    const psRes = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (psRes.ok) {
      const data = await psRes.json() as { models?: Array<{ name?: string }> };
      models = (data.models ?? []).map(m => m.name ?? '').filter(Boolean);
    }
  } catch (err) {
    logger.warn('[residency] ollama /api/ps failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (const model of models) {
    try {
      const res = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        logger.warn('[residency] ollama unload returned non-OK', { model, status: res.status });
      } else {
        await res.text(); // drain
        logger.info('[residency] unloaded ollama model', { model });
      }
    } catch (err) {
      logger.warn('[residency] ollama unload failed', {
        model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Poll ComfyUI's `/queue` and resolve only when both `queue_running` and
 * `queue_pending` are empty. Catches the case where someone hits ComfyUI
 * directly (port 8188, its own editor or curl) and Studio's scheduler
 * doesn't see the job — we still must not yank the model out from under
 * an in-flight execution.
 *
 * Best-effort: a fetch error counts as "queue unknown, assume not idle"
 * and we keep polling until the timeout. The caller's tenant switch is
 * blocked behind this.
 */
export async function waitForComfyIdle(timeoutMs = 30 * 60 * 1000): Promise<void> {
  const baseUrl = getComfyUIUrl();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/queue`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = await res.json() as {
          queue_running?: unknown[];
          queue_pending?: unknown[];
        };
        const running = Array.isArray(body.queue_running) ? body.queue_running.length : 0;
        const pending = Array.isArray(body.queue_pending) ? body.queue_pending.length : 0;
        if (running === 0 && pending === 0) return;
      }
    } catch {
      // /queue unreachable — treat as "still busy, retry"
    }
    // 1s poll cadence keeps responsiveness without hammering ComfyUI.
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  logger.warn('[residency] waitForComfyIdle timed out, proceeding anyway', {
    timeoutMs,
  });
}

export async function unloadComfy(): Promise<void> {
  // Hold off the /free until ComfyUI's queue is fully empty. This covers
  // BOTH studio-managed jobs (in flight via /api/generate) and direct
  // submissions hitting ComfyUI's own port. Without this guard the call
  // to /free below would unload the model mid-execution of whatever job
  // ComfyUI is currently running and break it.
  await waitForComfyIdle();
  const baseUrl = getComfyUIUrl();
  try {
    const res = await fetch(`${baseUrl}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn('[residency] comfyui /free returned non-OK', { status: res.status });
    } else {
      await res.text(); // drain
      logger.info('[residency] comfyui models unloaded');
    }
  } catch (err) {
    logger.warn('[residency] comfyui /free failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Best-effort wait for VRAM to drop after an unload. Uses nvidia-smi when
 * available; falls back to a 1.5s fixed delay. Never throws.
 */
export async function waitForVramDrop(
  targetFreeMB?: number,
  timeoutMs = 15000,
): Promise<void> {
  const hasSmi = await checkNvidiaSmiAvailable();
  if (!hasSmi) {
    // nvidia-smi unavailable — fixed delay.
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    return;
  }

  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=memory.free',
        '--format=csv,noheader,nounits',
      ]);
      const freeMB = parseInt(stdout.trim(), 10);
      if (!Number.isNaN(freeMB)) {
        if (targetFreeMB === undefined || freeMB >= targetFreeMB) return;
      }
    } catch {
      // nvidia-smi failed mid-flight — fall through after delay.
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
  }
  // Timed out — proceed anyway (best-effort).
}

/**
 * Ensure the given tenant owns VRAM. No-op if already resident.
 * Unloads the current tenant and optionally waits for VRAM to drop.
 */
export async function ensureResident(tenant: GpuTenant): Promise<void> {
  if (currentTenant === tenant) return;

  logger.info('[residency] switching tenant', { from: currentTenant, to: tenant });

  if (currentTenant === 'ollama') {
    await unloadOllama();
    await waitForVramDrop();
  } else if (currentTenant === 'comfy') {
    await unloadComfy();
    await waitForVramDrop();
  }

  currentTenant = tenant;
}
