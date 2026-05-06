// MCP server API client — plain fetch, no TanStack Query (not in this project).
// Mirrors the pattern in services/comfyui.ts: fetchJson wrapper, typed error.

const BASE = '/api/mcp';

export interface McpServerStatus {
  state: 'connected' | 'disconnected' | 'error';
  toolCount?: number;
  lastError?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  auth?: { type: 'bearer'; token: string };
  enabled: boolean;
  status?: McpServerStatus;
}

export type McpServerInput = Omit<McpServerConfig, 'id' | 'status'>;

export interface McpTestResult {
  ok: boolean;
  toolCount?: number;
  error?: string;
}

class McpApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'McpApiError';
    this.status = status;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && typeof data === 'object' && typeof data.error === 'string') {
        msg = data.error;
      }
    } catch { /* ignore */ }
    throw new McpApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export async function getMcpServers(): Promise<McpServerConfig[]> {
  const data = await fetchJson<{ servers: McpServerConfig[] }>(`${BASE}/servers`);
  return data.servers;
}

export async function addMcpServer(input: McpServerInput): Promise<McpServerConfig> {
  return fetchJson<McpServerConfig>(`${BASE}/servers`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateMcpServer(id: string, input: McpServerInput): Promise<McpServerConfig> {
  return fetchJson<McpServerConfig>(`${BASE}/servers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteMcpServer(id: string): Promise<void> {
  await fetchJson<unknown>(`${BASE}/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function testMcpServer(id: string): Promise<McpTestResult> {
  return fetchJson<McpTestResult>(`${BASE}/servers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  });
}

/* ---- Integrated MCP tools ---- */

export interface McpToolListing {
  name: string;
  label: string;
  description: string;
  category: 'comfy' | 'studio';
}

export interface McpToolsSettingsResponse {
  listings: McpToolListing[];
  enabled: Record<string, boolean>;
}

// Reads the slice we need from /api/system. Bundled with everything else
// the dashboard already fetches — no dedicated endpoint.
interface SystemPayload {
  chat?: {
    tools?: {
      enabledMcpTools?: Record<string, boolean>;
      mcpToolListings?: McpToolListing[];
      studioMcp?: StudioMcpStatus;
    };
  };
}

export async function getMcpToolsSettings(): Promise<McpToolsSettingsResponse> {
  const sys = await fetchJson<SystemPayload>('/api/system');
  const tools = sys.chat?.tools ?? {};
  return {
    listings: tools.mcpToolListings ?? [],
    enabled: tools.enabledMcpTools ?? {},
  };
}

export async function setMcpToolsEnabled(
  enabled: Record<string, boolean>,
): Promise<unknown> {
  return fetchJson<unknown>('/api/settings/tools', {
    method: 'PUT',
    body: JSON.stringify({ enabledMcpTools: enabled }),
  });
}

/* ---- Studio MCP server ---- */

export interface StudioMcpStatus {
  enabled: boolean;
  token: string | null;
}

export async function getStudioMcpStatus(): Promise<StudioMcpStatus> {
  const sys = await fetchJson<SystemPayload>('/api/system');
  return sys.chat?.tools?.studioMcp ?? { enabled: false, token: null };
}

/** Generate a fresh `studio_<32 hex>` token client-side and persist it via
 *  the existing secret endpoint. The presence of the token IS the enabled state. */
export async function enableStudioMcp(): Promise<{ enabled: true; token: string }> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const token = `studio_${hex}`;
  await fetchJson<unknown>('/api/settings/secret', {
    method: 'PUT',
    body: JSON.stringify({ studioMcpToken: token }),
  });
  return { enabled: true, token };
}

export async function disableStudioMcp(): Promise<{ enabled: false }> {
  await fetchJson<unknown>(
    `/api/settings/secret?name=studioMcpToken`,
    { method: 'DELETE' },
  );
  return { enabled: false };
}
