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

/**
 * Derive a stable, human-readable slug from a server's user-given name. The
 * slug is what appears in tool keys (`mcp__<slug>__<toolName>`) so users can
 * hand-edit `enabledMcpTools` without looking up server UUIDs.
 *
 * Rules: lowercase, non-alphanumeric collapsed to `-`, edge dashes trimmed.
 * Empty result falls back to a stable fragment of the server's UUID so the
 * key is still unique for unnamed entries.
 */
export function slugifyServerName(name: string, fallbackId?: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > 0) return slug;
  if (fallbackId) return `srv-${fallbackId.slice(0, 8)}`;
  return 'srv';
}

/** True when the candidate server's slug clashes with another existing server. */
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

/** Add a new server; id is generated here. Returns the created entry.
 *  Throws `McpSlugCollisionError` when the derived slug clashes.
 *  When created with `enabled: true`, the server's tools auto-surface to
 *  the chat LLM — see `_setProfileAllowAll`. The user-facing "Enabled"
 *  toggle in the modal controls connection AND chat exposure as one knob. */
export function addMcpServer(
  partial: Omit<McpServerConfig, 'id'>,
): McpServerConfig {
  const current = getMcpServers();
  if (slugCollides(current, partial.name)) {
    throw new McpSlugCollisionError(slugifyServerName(partial.name));
  }
  const server: McpServerConfig = { ...partial, id: randomUUID() };
  setMcpServers([...current, server]);
  if (server.enabled) _setProfileAllowAll(server.id, true);
  return server;
}

/** Update an existing server by id. Returns `true` if found and updated.
 *  Throws `McpSlugCollisionError` when a name change would clash with another server.
 *  When `enabled` changes, the default profile is updated to match (added on
 *  enable, removed on disable) so chat exposure tracks the toggle. */
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
  const next = current.map((s, i) =>
    i === idx ? { ...s, ...patch, id: s.id } : s,
  );
  setMcpServers(next);
  const after = next[idx]!;
  if (before.enabled !== after.enabled) {
    _setProfileAllowAll(id, after.enabled);
  }
  return true;
}

/** Remove a server by id. Returns `true` if found and removed.
 *  Cleans up references in every profile so a re-add with a recycled id
 *  doesn't inherit stale allow-list state. */
export function removeMcpServer(id: string): boolean {
  const current = getMcpServers();
  const next = current.filter((s) => s.id !== id);
  if (next.length === current.length) return false;
  setMcpServers(next);
  _removeFromAllProfiles(id);
  return true;
}

/** Default-profile helper: flip a server's allow-list to '*' (allow all
 *  tools) or remove the entry. Touches only the default profile so
 *  hand-curated power-user profiles aren't disturbed. */
function _setProfileAllowAll(serverId: string, allow: boolean): void {
  const profiles = getMcpProfiles();
  const def = { ...(profiles[DEFAULT_PROFILE_NAME] ?? {}) };
  if (allow) {
    def[serverId] = '*';
  } else {
    delete def[serverId];
  }
  save({ ...load(), mcpProfiles: { ...profiles, [DEFAULT_PROFILE_NAME]: def } });
}

/** Cleanup helper for `removeMcpServer`: drop the deleted server's entry
 *  from every named profile. */
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

// ---- enabledMcpTools UUID → slug migration ------------------------------

type WithEnabledTools = ExtendedSettings & { enabledMcpTools?: Record<string, boolean> };

/**
 * Rewrite legacy `mcp__<UUID>__<tool>` keys in `enabledMcpTools` to
 * `mcp__<slug>__<tool>` whenever the UUID matches an existing server.
 *
 * Idempotent — keys that already use a slug, or whose UUID has no matching
 * server (orphaned), are left untouched. Two servers slugging to the same
 * value are rejected at write time, so a "merge collision" is impossible
 * here unless settings were corrupted out-of-band; in that case we keep the
 * UUID-keyed entry so the user can resolve manually.
 *
 * Returns the number of keys rewritten.
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
    if (slug === undefined) { next[key] = value; continue; }   // not a UUID we know — leave alone
    if (slug === ns) { next[key] = value; continue; }          // already a slug (defensive)
    const newKey = `mcp__${slug}__${tool}`;
    if (next[newKey] === undefined) next[newKey] = value;
    rewrites++;
  }
  if (rewrites === 0) return 0;
  save({ ...current, enabledMcpTools: next } as ExtendedSettings);
  return rewrites;
}

/**
 * Backfill the default profile from already-enabled servers. Older Studio
 * builds treated `server.enabled` and `mcpProfiles[default][id]` as two
 * independent toggles, leaving users with connected servers whose tools
 * never reached the chat. This migration aligns them: every enabled
 * server gets `'*'` in the default profile if it has no entry yet.
 *
 * Idempotent. Returns the number of servers backfilled.
 */
export function migrateMcpProfilesFromEnabled(): number {
  const servers = getMcpServers();
  const profiles = getMcpProfiles();
  const def = { ...(profiles[DEFAULT_PROFILE_NAME] ?? {}) };
  let added = 0;
  for (const s of servers) {
    if (!s.enabled) continue;
    if (def[s.id] !== undefined) continue;     // already curated by the user
    def[s.id] = '*';
    added++;
  }
  if (added === 0) return 0;
  save({ ...load(), mcpProfiles: { ...profiles, [DEFAULT_PROFILE_NAME]: def } });
  return added;
}
