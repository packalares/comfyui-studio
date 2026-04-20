import { env } from '../config/env.js';
import { detectMediaType, collectNodeOutputFiles } from '../lib/mediaType.js';
import type { GalleryItem } from '../contracts/generation.contract.js';

const COMFYUI_URL = env.COMFYUI_URL;

export { detectMediaType, collectNodeOutputFiles };
export type { GalleryItem };

export function getComfyUIUrl(): string {
  return COMFYUI_URL;
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
    // Surface ComfyUI's error body (usually JSON with { error: { message, details, ... } })
    // so the caller can show a meaningful message instead of a bare status code.
    let detail = '';
    try { detail = ' — ' + (await res.text()).slice(0, 1000); } catch { /* ignore */ }
    throw new Error(`ComfyUI API error: ${res.status} ${res.statusText} at ${path}${detail}`);
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

export async function getHistory(maxItems = 50) {
  return fetchComfyUI(`/api/history?max_items=${maxItems}`);
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
