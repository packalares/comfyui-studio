// Boot-time probe: detect what was running when Studio started and align
// the scheduler's residency state to match. Runs once after DB init.

import { getComfyUIUrl } from '../comfyui/api.js';
import { getOllamaUrl } from '../settings/index.js';
import { forceSetTenant } from './residency.js';
import { unloadOllama } from './residency.js';
import { logger } from '../../lib/logger.js';
import type { GpuTenant } from './taskTypes.js';

const PROBE_TIMEOUT_MS = 5000;

interface ComfyQueueResponse {
  queue_running?: unknown[];
  queue_pending?: unknown[];
}

interface OllamaPsResponse {
  models?: Array<{ name?: string }>;
}

async function probeComfyBusy(): Promise<boolean> {
  try {
    const res = await fetch(`${getComfyUIUrl()}/api/queue`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = await res.json() as ComfyQueueResponse;
    return (
      (data.queue_running?.length ?? 0) > 0 ||
      (data.queue_pending?.length ?? 0) > 0
    );
  } catch {
    return false;
  }
}

async function probeOllamaLoaded(): Promise<boolean> {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/ps`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const data = await res.json() as OllamaPsResponse;
    return (data.models?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Probe ComfyUI and Ollama in parallel at boot, then align residency state.
 *
 * Rules:
 *   - ComfyUI busy + Ollama loaded → trust ComfyUI first; proactively unload Ollama.
 *   - Only ComfyUI busy → set residency 'comfy'.
 *   - Only Ollama loaded → set residency 'ollama'.
 *   - Neither → residency stays 'none'.
 *   - Probe failure (timeout) → residency 'none'. Log warn.
 *
 * Does NOT delay the first scheduled job — the scheduler's ensureResident()
 * will handle any in-flight ComfyUI prompts (they'll either finish naturally
 * or get OOM'd; we can't safely defer indefinitely).
 */
export async function bootRecovery(): Promise<void> {
  let comfyBusy = false;
  let ollamaLoaded = false;

  try {
    [comfyBusy, ollamaLoaded] = await Promise.all([
      probeComfyBusy(),
      probeOllamaLoaded(),
    ]);
  } catch (err) {
    logger.warn('[bootRecovery] probe failed; proceeding with residency=none', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let tenant: GpuTenant = 'none';

  if (comfyBusy && ollamaLoaded) {
    // Both busy — trust ComfyUI; kick Ollama out to free VRAM.
    logger.warn('[bootRecovery] both ComfyUI and Ollama report active; unloading Ollama');
    await unloadOllama().catch((err) => {
      logger.warn('[bootRecovery] proactive Ollama unload failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    tenant = 'comfy';
  } else if (comfyBusy) {
    tenant = 'comfy';
  } else if (ollamaLoaded) {
    tenant = 'ollama';
  }

  if (tenant !== 'none') {
    forceSetTenant(tenant);
    logger.info('[bootRecovery] initial GPU residency', { tenant });
  }
}
