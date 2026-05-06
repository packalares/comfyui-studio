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
 * Heuristic for "Ollama and ComfyUI probably share a GPU." Assumes co-located
 * by default. Only returns false when the Ollama URL points at an obviously
 * remote host — a public FQDN (`example.com`) or raw IP (`1.2.3.4`).
 *
 * Captures these as co-located:
 *   - loopback hosts (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`)
 *   - bare Kubernetes service names (`ollama`, `comfyui`)
 *   - container/cluster DNS (`*.svc`, `*.cluster.local`, `*.local`)
 *   - same-hostname matches
 *
 * Strict hostname-equality was too conservative for in-cluster deployments
 * where `ollama` (k8s service) lands on the same node as a `localhost`-bound
 * Studio process — that combo skipped the unload despite real GPU contention.
 * The new rule errs toward unloading: cost of a needless unload is one cold
 * reload (~3-30s on next turn). Cost of skipping a real unload is OOM /
 * thrash. The asymmetry says default-true.
 */
export function isLikelyColocated(): boolean {
  try {
    const ollama = new URL(getOllamaUrl()).hostname;
    const comfy = new URL(getComfyUIUrl()).hostname;
    const isLoopback = (h: string): boolean =>
      h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1';
    if (ollama === comfy) return true;
    if (isLoopback(ollama) || isLoopback(comfy)) return true;
    // Cluster / container DNS suffixes count as local enough.
    const isClusterDns = (h: string): boolean =>
      h.endsWith('.svc') || h.endsWith('.cluster.local') || h.endsWith('.local');
    if (isClusterDns(ollama) || isClusterDns(comfy)) return true;
    // Bare hostname (no dot) — k8s service name or docker container alias.
    // Treat as local; remote endpoints almost always carry a TLD.
    if (!ollama.includes('.') || !comfy.includes('.')) return true;
    // Both resolved with a dotted FQDN or raw IP — likely remote.
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
