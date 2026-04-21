import { env } from '../config/env.js';
import { detectMediaType, collectNodeOutputFiles } from '../lib/mediaType.js';
import type { GalleryItem } from '../contracts/generation.contract.js';

const COMFYUI_URL = env.COMFYUI_URL;

export { detectMediaType, collectNodeOutputFiles };
export type { GalleryItem };

export function getComfyUIUrl(): string {
  return COMFYUI_URL;
}

/**
 * Typed error thrown when ComfyUI returns a non-2xx response. Callers that
 * want to surface structured validation failures (e.g. /api/prompt's
 * `node_errors`) inspect `status` + `body` directly instead of parsing the
 * message string.
 */
export class ComfyUIHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly path: string;
  constructor(status: number, statusText: string, path: string, body: string) {
    super(`ComfyUI API error: ${status} ${statusText} at ${path}${body ? ' — ' + body.slice(0, 500) : ''}`);
    this.name = 'ComfyUIHttpError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export async function fetchComfyUI<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${COMFYUI_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 2000); } catch { /* ignore */ }
    throw new ComfyUIHttpError(res.status, res.statusText, path, body);
  }
  return res.json() as Promise<T>;
}

export async function getSystemStats() {
  return fetchComfyUI('/api/system_stats');
}

export async function getQueue() {
  const data = await fetchComfyUI<{ queue_running: unknown[]; queue_pending: unknown[] }>('/api/queue');
  return {
    queue_running: data.queue_running?.length || 0,
    queue_pending: data.queue_pending?.length || 0,
  };
}

/** Same `/api/queue` call as `getQueue` but returns the set of active prompt
 *  ids (running + pending). Used by `gallery.sentry` to detect completions. */
export async function getQueuePromptIds(): Promise<Set<string>> {
  const data = await fetchComfyUI<{
    queue_running: unknown[]; queue_pending: unknown[];
  }>('/api/queue');
  const ids = new Set<string>();
  for (const entry of [...(data.queue_running ?? []), ...(data.queue_pending ?? [])]) {
    if (!Array.isArray(entry)) continue;
    const pid = entry[1];
    if (typeof pid === 'string' && pid.length > 0) ids.add(pid);
  }
  return ids;
}

export async function getHistory(maxItems = 50) {
  return fetchComfyUI(`/api/history?max_items=${maxItems}`);
}

/**
 * Fetch one entry from `/api/history/:promptId`. ComfyUI returns a
 * `{ [promptId]: { prompt, outputs, status, ... } }` shape even for the
 * single-id endpoint, so we unwrap to the inner entry here. Returns null
 * when the id is unknown to ComfyUI (history entries age out after a
 * server restart).
 */
export async function getHistoryForPrompt(
  promptId: string,
): Promise<{
  prompt?: unknown;
  outputs?: Record<string, Record<string, unknown>>;
} | null> {
  const data = await fetchComfyUI<Record<string, {
    prompt?: unknown;
    outputs?: Record<string, Record<string, unknown>>;
  }>>(`/api/history/${promptId}`);
  return data[promptId] ?? null;
}

/**
 * Remove one or more entries from ComfyUI's `/api/history` by prompt id.
 * Used by gallery delete so an item wiped in Studio doesn't get revived the
 * next time the user hits Import-from-ComfyUI. Swallows errors — the gallery
 * row + file are already gone, so a failed upstream delete is non-fatal.
 */
export async function deleteHistoryPrompts(promptIds: string[]): Promise<void> {
  if (promptIds.length === 0) return;
  try {
    await fetch(`${COMFYUI_URL}/api/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: promptIds }),
    });
  } catch {
    /* best-effort — see fn docstring */
  }
}

export async function submitPrompt(
  workflow: Record<string, unknown>,
  opts?: { attachApiKey?: boolean },
) {
  const body: Record<string, unknown> = { prompt: workflow };
  if (opts?.attachApiKey) {
    const { getApiKey } = await import('./settings.js');
    const apiKey = getApiKey();
    if (apiKey) body.extra_data = { api_key_comfy_org: apiKey };
  }
  return fetchComfyUI<{ prompt_id: string }>('/api/prompt', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function proxyView(filename: string, subfolder?: string): Promise<Response> {
  const params = new URLSearchParams({ filename });
  if (subfolder) params.set('subfolder', subfolder);
  return fetch(`${COMFYUI_URL}/api/view?${params.toString()}`);
}

export async function getGalleryItems(): Promise<GalleryItem[]> {
  const history = await fetchComfyUI<Record<string, { outputs?: Record<string, Record<string, unknown>> }>>('/api/history?max_items=100');
  const items: GalleryItem[] = [];
  for (const [promptId, entry] of Object.entries(history)) {
    if (!entry.outputs) continue;
    for (const nodeOutput of Object.values(entry.outputs)) {
      for (const f of collectNodeOutputFiles(nodeOutput)) {
        const subfolder = f.subfolder || '';
        const type = f.type || 'output';
        items.push({
          id: `${promptId}-${f.filename}`,
          filename: f.filename,
          subfolder,
          type,
          mediaType: detectMediaType(f.filename),
          url: `/api/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`,
          promptId,
        });
      }
    }
  }
  return items;
}
