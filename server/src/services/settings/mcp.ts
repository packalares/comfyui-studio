import { randomUUID, randomBytes } from 'crypto';
import { _loadInternal, _saveInternal, type SettingsInternal } from './store.js';

export interface McpServerConfig {
  /** Backend-assigned uuid. */
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  /** stdio: executable to spawn (e.g. 'npx'). */
  command?: string;
  /** stdio: argv passed to command. */
  args?: string[];
  /** http: endpoint URL. */
  url?: string;
  auth?: { type: 'bearer'; token: string };
  enabled: boolean;
}

/** Maps serverId -> '*' (all tools) or string[] (tool allow-list). Absent = no tools surfaced. */
export type Profile = Record<string, '*' | string[]>;

export const DEFAULT_PROFILE_NAME = 'studio-chat-default';

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

/**
 * Derive a stable slug from a server name for use in tool keys
 * (`mcp__<slug>__<toolName>`). Falls back to a UUID fragment for unnamed entries.
 */
export function slugifyServerName(name: string, fallbackId?: string): string {
  const slug = name.toLowerCase()
    // Collapse every run of non-alphanumerics to a single '-', so at most one
    // leading/trailing '-' can remain — single-char trims below then need no
    // backtracking anchor (`-+$` is polynomial on many '-').
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');
  if (slug.length > 0) return slug;
  if (fallbackId) return `srv-${fallbackId.slice(0, 8)}`;
  return 'srv';
}

function slugCollides(
  servers: McpServerConfig[],
  candidateName: string,
  ignoreId?: string,
): boolean {
  const candidateSlug = slugifyServerName(candidateName);
  return servers.some(s => s.id !== ignoreId && slugifyServerName(s.name, s.id) === candidateSlug);
}

export class McpSlugCollisionError extends Error {
  constructor(slug: string) {
    super(`Another MCP server already uses slug "${slug}". Pick a different name.`);
    this.name = 'McpSlugCollisionError';
  }
}

export function getMcpServers(): McpServerConfig[] {
  return load().mcpServers ?? [];
}

export function setMcpServers(servers: McpServerConfig[]): void {
  save({ ...load(), mcpServers: servers });
}

/** Add a new server (id generated here). Throws `McpSlugCollisionError` on name clash.
 *  When `enabled: true`, the server's tools are auto-surfaced to the chat LLM. */
export function addMcpServer(partial: Omit<McpServerConfig, 'id'>): McpServerConfig {
  const current = getMcpServers();
  if (slugCollides(current, partial.name)) {
    throw new McpSlugCollisionError(slugifyServerName(partial.name));
  }
  const server: McpServerConfig = { ...partial, id: randomUUID() };
  setMcpServers([...current, server]);
  if (server.enabled) _setProfileAllowAll(server.id, true);
  return server;
}

/** Update an existing server by id. Returns `true` if found.
 *  Throws `McpSlugCollisionError` on name clash. Syncs default profile on enabled toggle. */
export function updateMcpServer(
  id: string,
  patch: Partial<Omit<McpServerConfig, 'id'>>,
): boolean {
  const current = getMcpServers();
  const idx = current.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (typeof patch.name === 'string' && slugCollides(current, patch.name, id)) {
    throw new McpSlugCollisionError(slugifyServerName(patch.name));
  }
  const before = current[idx]!;
  const next = current.map((s, i) => i === idx ? { ...s, ...patch, id: s.id } : s);
  setMcpServers(next);
  const after = next[idx]!;
  if (before.enabled !== after.enabled) _setProfileAllowAll(id, after.enabled);
  return true;
}

/** Remove a server by id, cleaning up all profile references. Returns `true` if found. */
export function removeMcpServer(id: string): boolean {
  const current = getMcpServers();
  const next = current.filter((s) => s.id !== id);
  if (next.length === current.length) return false;
  setMcpServers(next);
  _removeFromAllProfiles(id);
  return true;
}

// Flip a server's default-profile entry to '*' or remove it; leaves power-user profiles alone.
function _setProfileAllowAll(serverId: string, allow: boolean): void {
  const profiles = getMcpProfiles();
  const def = { ...(profiles[DEFAULT_PROFILE_NAME] ?? {}) };
  if (allow) { def[serverId] = '*'; } else { delete def[serverId]; }
  save({ ...load(), mcpProfiles: { ...profiles, [DEFAULT_PROFILE_NAME]: def } });
}

// Drop a deleted server's entry from every named profile.
function _removeFromAllProfiles(serverId: string): void {
  const profiles = getMcpProfiles();
  const next: Record<string, Profile> = {};
  for (const [name, prof] of Object.entries(profiles)) {
    const cleaned: Profile = {};
    for (const [sid, allow] of Object.entries(prof)) {
      if (sid !== serverId) cleaned[sid] = allow;
    }
    next[name] = cleaned;
  }
  save({ ...load(), mcpProfiles: next });
}

export function getMcpProfiles(): Record<string, Profile> {
  const profiles = load().mcpProfiles ?? {};
  // Always expose the default profile
  if (!profiles[DEFAULT_PROFILE_NAME]) profiles[DEFAULT_PROFILE_NAME] = {};
  return profiles;
}

/** Upsert a named profile. */
export function upsertMcpProfile(name: string, profile: Profile): void {
  const profiles = getMcpProfiles();
  save({ ...load(), mcpProfiles: { ...profiles, [name]: profile } });
}

// ---- Studio MCP bearer token ----

type WithMcpToken = ExtendedSettings & { studioMcpToken?: string };

/** Returns the configured bearer token, or null (→ route returns 503). */
export function getStudioMcpToken(): string | null {
  const v = (load() as WithMcpToken).studioMcpToken;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Persist or clear the Studio MCP bearer token. Pass null to disable. */
export function setStudioMcpToken(token: string | null): void {
  const current = load() as WithMcpToken;
  if (token === null || token === '') {
    const { studioMcpToken: _r, ...rest } = current;
    save(rest as ExtendedSettings);
  } else {
    save({ ...current, studioMcpToken: token } as ExtendedSettings);
  }
}

/** Mint a fresh `studio_<32 hex chars>` token, persist it, return status. */
export function enableStudioMcp(): { enabled: true; token: string } {
  const token = `studio_${randomBytes(16).toString('hex')}`;
  setStudioMcpToken(token);
  return { enabled: true, token };
}

/** Clear the token — MCP server will return 503 on all requests. */
export function disableStudioMcp(): { enabled: false } {
  setStudioMcpToken(null);
  return { enabled: false };
}

// SECURITY: never returns the raw token. The token is shown once at mint-time
// and never exposed via a read endpoint to prevent leakage through GET /api/system.
export function getStudioMcpStatus(): { enabled: boolean; tokenConfigured: boolean } {
  const token = getStudioMcpToken();
  return { enabled: token !== null, tokenConfigured: token !== null };
}

// ---- enabledMcpTools UUID → slug migration ----

type WithEnabledTools = ExtendedSettings & { enabledMcpTools?: Record<string, boolean> };

/**
 * Rewrite legacy `mcp__<UUID>__<tool>` keys to `mcp__<slug>__<tool>` where the
 * UUID matches a known server. Idempotent; orphaned or already-slugged keys are
 * left untouched. Returns the count of rewritten keys.
 */
export function migrateEnabledMcpToolKeys(): number {
  const current = load() as WithEnabledTools;
  const enabled = current.enabledMcpTools;
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return 0;
  const servers = getMcpServers();
  const idToSlug = new Map<string, string>();
  for (const s of servers) idToSlug.set(s.id, slugifyServerName(s.name, s.id));

  let rewrites = 0;
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(enabled)) {
    const parts = key.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') { next[key] = value; continue; }
    const ns = parts[1];
    const tool = parts.slice(2).join('__');
    const slug = idToSlug.get(ns);
    if (slug === undefined) { next[key] = value; continue; }
    if (slug === ns) { next[key] = value; continue; }
    const newKey = `mcp__${slug}__${tool}`;
    if (next[newKey] === undefined) next[newKey] = value;
    rewrites++;
  }
  if (rewrites === 0) return 0;
  save({ ...current, enabledMcpTools: next } as ExtendedSettings);
  return rewrites;
}

/**
 * Backfill the default profile from already-enabled servers. Aligns older
 * builds where `server.enabled` and the profile entry were independent toggles.
 * Idempotent. Returns the count of backfilled servers.
 */
export function migrateMcpProfilesFromEnabled(): number {
  const servers = getMcpServers();
  const profiles = getMcpProfiles();
  const def = { ...(profiles[DEFAULT_PROFILE_NAME] ?? {}) };
  let added = 0;
  for (const s of servers) {
    if (!s.enabled) continue;
    if (def[s.id] !== undefined) continue;
    def[s.id] = '*';
    added++;
  }
  if (added === 0) return 0;
  save({ ...load(), mcpProfiles: { ...profiles, [DEFAULT_PROFILE_NAME]: def } });
  return added;
}
