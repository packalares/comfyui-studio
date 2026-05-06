// MCP server configs and profiles settings.
// Shares the same JSON file and in-memory cache as settings.ts via
// `_loadInternal` / `_saveInternal`.

import { randomUUID, randomBytes } from 'crypto';
import { _loadInternal, _saveInternal, type SettingsInternal } from './settings.js';

// ---- Types ---------------------------------------------------------------

export interface McpServerConfig {
  /** Backend-assigned uuid. */
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  /** stdio: executable to spawn (e.g. 'npx'). */
  command?: string;
  /** stdio: argv passed to command (e.g. ['-y', '@upstash/context7-mcp']). */
  args?: string[];
  /** http: endpoint URL. */
  url?: string;
  auth?: { type: 'bearer'; token: string };
  enabled: boolean;
}

/**
 * Profile: maps serverId -> '*' (all tools) or string[] (tool name allow-list).
 * An absent serverId means none of that server's tools are surfaced.
 */
export type Profile = Record<string, '*' | string[]>;

export const DEFAULT_PROFILE_NAME = 'studio-chat-default';

// ---- Internal helpers ----------------------------------------------------

type ExtendedSettings = SettingsInternal & {
  mcpServers?: McpServerConfig[];
  mcpProfiles?: Record<string, Profile>;
};

function load(): ExtendedSettings {
  return _loadInternal() as ExtendedSettings;
}

function save(next: ExtendedSettings): void {
  _saveInternal(next as SettingsInternal);
}

// ---- Servers -------------------------------------------------------------

export function getMcpServers(): McpServerConfig[] {
  return load().mcpServers ?? [];
}

export function setMcpServers(servers: McpServerConfig[]): void {
  save({ ...load(), mcpServers: servers });
}

/** Add a new server; id is generated here. Returns the created entry. */
export function addMcpServer(
  partial: Omit<McpServerConfig, 'id'>,
): McpServerConfig {
  const server: McpServerConfig = { ...partial, id: randomUUID() };
  const current = getMcpServers();
  setMcpServers([...current, server]);
  return server;
}

/** Update an existing server by id. Returns `true` if found and updated. */
export function updateMcpServer(
  id: string,
  patch: Partial<Omit<McpServerConfig, 'id'>>,
): boolean {
  const current = getMcpServers();
  const idx = current.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  const next = current.map((s, i) =>
    i === idx ? { ...s, ...patch, id: s.id } : s,
  );
  setMcpServers(next);
  return true;
}

/** Remove a server by id. Returns `true` if found and removed. */
export function removeMcpServer(id: string): boolean {
  const current = getMcpServers();
  const next = current.filter((s) => s.id !== id);
  if (next.length === current.length) return false;
  setMcpServers(next);
  return true;
}

// ---- Profiles ------------------------------------------------------------

export function getMcpProfiles(): Record<string, Profile> {
  const profiles = load().mcpProfiles ?? {};
  // Always expose the default profile
  if (!profiles[DEFAULT_PROFILE_NAME]) {
    profiles[DEFAULT_PROFILE_NAME] = {};
  }
  return profiles;
}

/** Upsert a named profile. */
export function upsertMcpProfile(name: string, profile: Profile): void {
  const profiles = getMcpProfiles();
  save({ ...load(), mcpProfiles: { ...profiles, [name]: profile } });
}

// ---- Studio MCP server bearer token -------------------------------------

type WithMcpToken = ExtendedSettings & { studioMcpToken?: string };

/** Return the configured Studio MCP bearer token, or null (route returns 503). */
export function getStudioMcpToken(): string | null {
  const v = (load() as WithMcpToken).studioMcpToken;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Persist or clear the Studio MCP bearer token. Pass null to disable MCP. */
export function setStudioMcpToken(token: string | null): void {
  const current = load() as WithMcpToken;
  if (token === null || token === '') {
    const { studioMcpToken: _r, ...rest } = current;
    save(rest as ExtendedSettings);
  } else {
    save({ ...current, studioMcpToken: token } as ExtendedSettings);
  }
}

/** Generate a fresh `studio_<32 hex chars>` token, persist it, return status. */
export function enableStudioMcp(): { enabled: true; token: string } {
  const token = `studio_${randomBytes(16).toString('hex')}`;
  setStudioMcpToken(token);
  return { enabled: true, token };
}

/** Clear the token — MCP server will return 503 on requests. */
export function disableStudioMcp(): { enabled: false } {
  setStudioMcpToken(null);
  return { enabled: false };
}

/** Current Studio MCP server enable state (for the settings UI). */
export function getStudioMcpStatus(): { enabled: boolean; token: string | null } {
  const token = getStudioMcpToken();
  return { enabled: token !== null, token };
}
