// GPU orchestrator: unloads Ollama from VRAM just before a tool dispatch
// that needs the GPU exclusively (e.g. `generate_image` → ComfyUI). On a
// co-located host the LLM and the diffusion pipeline fight for the same
// VRAM, and the larger of the two OOMs without warning. Unloading the LLM
// first keeps ComfyUI happy; reload happens lazily on the next /api/chat
// (Ollama re-paged-in by the next user turn — no explicit reload here).
//
// Three short-circuits, in order:
//   1. The tool didn't opt in (`unloadGpuOnUse: false`) → no-op.
//   2. Ollama and ComfyUI are on different hosts (different hostnames and
//      not both loopback) → assume separate GPUs, no contention, no-op.
//   3. Ollama isn't currently loaded (`/api/ps` says no) → nothing to do.
//
// All three pass → emit a `freeing_gpu` chat-status event for the UI banner,
// then POST `/api/generate` with `keep_alive: 0` (Ollama's documented
// unload pattern). Network failures are logged but never thrown — the tool
// still runs and the worst-case is the original OOM, which is what we
// already had before this orchestrator existed.

import { isModelLoaded } from './ollamaPs.js';
import { getOllamaUrl } from '../settings.js';
import { getComfyUIUrl } from '../comfyui.js';
import { logger } from '../../lib/logger.js';
import type { StudioTool } from './tools/defineTool.js';

const UNLOAD_TIMEOUT_MS = 2000;

/**
 * True when Ollama and ComfyUI appear to share a host (same hostname or both
 * loopback addresses). Hostname collision is a proxy for "they share a GPU";
 * operators with separate GPU nodes will have different hostnames and we
 * skip the unload accordingly.
 */
export function isLikelyColocated(): boolean {
  try {
    const ollama = new URL(getOllamaUrl()).hostname;
    const comfy = new URL(getComfyUIUrl()).hostname;
    const isLoopback = (h: string): boolean =>
      h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1';
    if (ollama === comfy) return true;
    if (isLoopback(ollama) && isLoopback(comfy)) return true;
    return false;
  } catch {
    // Bad URL — be conservative, assume co-located so we still unload.
    return true;
  }
}

/**
 * POST /api/generate with empty prompt + keep_alive: 0 — Ollama's documented
 * unload pattern. Returns immediately; no body needed.
 */
async function unloadOllamaModel(model: string): Promise<void> {
  const baseUrl = getOllamaUrl();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
      signal: ac.signal,
    });
    if (!res.ok) {
      logger.warn('gpu orchestrator: unload returned non-OK', { status: res.status });
      return;
    }
    // Drain so the connection closes cleanly.
    await res.text();
    logger.info('gpu orchestrator: unloaded ollama model', { model });
  } catch (err) {
    logger.warn('gpu orchestrator: unload failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

export type GpuStatusCode = 'freeing_gpu';

export interface BeforeToolDeps {
  /** Emitter to broadcast `chat:status` envelopes to the UI. Pass-through
   *  from streamChat so the orchestrator stays decoupled from chatEvents. */
  emitStatus: (code: GpuStatusCode, message?: string) => void;
}

/**
 * Called BEFORE each tool dispatch. See file header for the three
 * short-circuits. When all three pass: emit `freeing_gpu` for the UI
 * banner, then unload. Reload is lazy — the next `/api/chat` re-paginates
 * the model in.
 */
export async function beforeTool(
  studioTool: StudioTool,
  model: string,
  deps: BeforeToolDeps,
): Promise<void> {
  if (!studioTool.unloadGpuOnUse) return;
  if (!isLikelyColocated()) return;
  const baseUrl = getOllamaUrl();
  const loaded = await isModelLoaded(baseUrl, model);
  if (!loaded) return;
  deps.emitStatus('freeing_gpu', 'Freeing GPU for tool…');
  await unloadOllamaModel(model);
}
