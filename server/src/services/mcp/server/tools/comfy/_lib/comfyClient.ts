// Thin ComfyUI HTTP client for MCP tools.
// Wraps Studio's existing `fetchComfyUI` / `getComfyUIUrl()` from
// `services/comfyui.ts` so MCP tools never import env vars directly.

import { fetchComfyUI, getComfyUIUrl, ComfyUIHttpError } from '../../../../../comfyui.js';
import { logger } from '../../../../../../lib/logger.js';

export { ComfyUIHttpError };

export interface SystemStats {
  system: {
    os: string;
    python_version: string;
    embedded_python: boolean;
    argv?: string[];
    comfyui_version?: string;
  };
  devices: Array<{
    name: string;
    type: string;
    index: number;
    vram_total: number;
    vram_free: number;
    torch_vram_total: number;
    torch_vram_free: number;
  }>;
}

export type ObjectInfo = Record<string, {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  output?: string[];
  output_node?: boolean;
  display_name?: string;
  description?: string;
  category?: string;
}>;

export async function mcpFetch<T>(path: string, init?: RequestInit): Promise<T> {
  logger.debug('MCP comfy fetch', { path });
  return fetchComfyUI<T>(path, init);
}

export async function getSystemStats(): Promise<SystemStats> {
  return mcpFetch<SystemStats>('/api/system_stats');
}

export async function getObjectInfo(): Promise<ObjectInfo> {
  return mcpFetch<ObjectInfo>('/api/object_info');
}

export async function postFree(body: { unload_models: boolean; free_memory: boolean }): Promise<Response> {
  const url = `${getComfyUIUrl()}/free`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
