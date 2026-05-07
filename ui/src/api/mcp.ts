// MCP server API client. Thin domain wrapper around the shared `fetchJson` in
// `services/comfyui.ts` — same `/api` prefix, same error class, same in-flight
// GET dedupe. This file owns the URL paths and response shapes; transport
// concerns live next door.

import { fetchJson } from '../services/comfyui';

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

// The GET /api/mcp/servers wire shape nests runtime status under the key
// `state` (e.g. { status: 'connected', toolCount: 2, lastError?: string })
// while the UI domain uses `status` with the connection state under `state`.
// Both keys are flipped at both levels — server wire `state.status` becomes
// UI `status.state`. POST/PUT return `{ server: {...} }` without runtime
// fields. All variants are normalised here so the rest of the UI only ever
// sees McpServerConfig.
interface WireServerState {
  status: 'connected' | 'disconnected' | 'error' | 'connecting';
  toolCount?: number;
  lastError?: string;
}
interface RawServerItem extends Omit<McpServerConfig, 'status'> {
  state?: WireServerState;
}

function normalizeServer(raw: RawServerItem): McpServerConfig {
  const { state, ...rest } = raw;
  if (!state) return rest;
  // Treat 'connecting' as 'disconnected' for UI purposes — the badge has no
  // dedicated visual for it, and it's a transient that resolves quickly.
  const uiState: McpServerStatus['state'] =
    state.status === 'connected' ? 'connected'
    : state.status === 'error' ? 'error'
    : 'disconnected';
  return {
    ...rest,
    status: {
      state: uiState,
      toolCount: state.toolCount,
      lastError: state.lastError,
    },
  };
}

export async function getMcpServers(): Promise<McpServerConfig[]> {
  const data = await fetchJson<{ servers: RawServerItem[] }>('/mcp/servers');
  return data.servers.map(normalizeServer);
}

export async function addMcpServer(input: McpServerInput): Promise<McpServerConfig> {
  const data = await fetchJson<{ server: RawServerItem }>('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return normalizeServer(data.server);
}

export async function updateMcpServer(id: string, input: McpServerInput): Promise<McpServerConfig> {
  const data = await fetchJson<{ server: RawServerItem }>(`/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return normalizeServer(data.server);
}

export async function deleteMcpServer(id: string): Promise<void> {
  await fetchJson<unknown>(`/mcp/servers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function testMcpServer(id: string): Promise<McpTestResult> {
  return fetchJson<McpTestResult>(`/mcp/servers/${encodeURIComponent(id)}/test`, {
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
  const sys = await fetchJson<SystemPayload>('/system');
  const tools = sys.chat?.tools ?? {};
  return {
    listings: tools.mcpToolListings ?? [],
    enabled: tools.enabledMcpTools ?? {},
  };
}

export async function setMcpToolsEnabled(
  enabled: Record<string, boolean>,
): Promise<unknown> {
  return fetchJson<unknown>('/settings/tools', {
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
  const sys = await fetchJson<SystemPayload>('/system');
  return sys.chat?.tools?.studioMcp ?? { enabled: false, token: null };
}

/** Generate a fresh `studio_<32 hex>` token client-side and persist it via
 *  the existing secret endpoint. The presence of the token IS the enabled state. */
export async function enableStudioMcp(): Promise<{ enabled: true; token: string }> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const token = `studio_${hex}`;
  await fetchJson<unknown>('/settings/secret', {
    method: 'PUT',
    body: JSON.stringify({ studioMcpToken: token }),
  });
  return { enabled: true, token };
}

export async function disableStudioMcp(): Promise<{ enabled: false }> {
  await fetchJson<unknown>(
    '/settings/secret?name=studioMcpToken',
    { method: 'DELETE' },
  );
  return { enabled: false };
}
