// Profile loader: reads MCP profiles from settings and exposes the active
// allow-list for a given profile name.
//
// Default profile name is 'studio-chat-default'. An absent server entry in
// the profile means zero tools from that server are surfaced.

import {
  getMcpProfiles,
  getMcpServers,
  slugifyServerName,
  DEFAULT_PROFILE_NAME,
  type Profile,
} from '../../settings.mcp.js';

export { DEFAULT_PROFILE_NAME };

/**
 * Load all profiles from settings. The default profile is always present
 * (may be empty — no servers surfaced).
 */
export function loadProfiles(): Record<string, Profile> {
  return getMcpProfiles();
}

/**
 * Resolve the allow-list for one server within a profile.
 *
 * Returns:
 *  - `'*'`      — all tools from this server should be exposed.
 *  - `string[]` — only the listed tool names should be exposed.
 *  - `null`     — server not in profile; expose nothing.
 */
export function serverAllowList(
  profile: Profile,
  serverId: string,
): '*' | string[] | null {
  const entry = profile[serverId];
  if (entry === undefined) return null;
  if (entry === '*') return '*';
  if (Array.isArray(entry)) return entry;
  return null;
}

/**
 * Given a map of all namespaced tools from all servers (`mcp__<slug>__name`)
 * and a named profile, return the keys that pass the filter.
 *
 * Tool keys carry the server *slug* (derived from the user-given name) but
 * profile entries are still keyed by server *UUID* — so we resolve slug →
 * server.id before looking up the allow-list.
 */
export function filterByProfile(
  toolKeys: string[],
  profile: Profile,
): string[] {
  // Build slug → id once per call. Servers list is short; cost is trivial.
  const slugToId = new Map<string, string>();
  for (const s of getMcpServers()) slugToId.set(slugifyServerName(s.name, s.id), s.id);

  return toolKeys.filter((key) => {
    // Format: mcp__<slug>__<toolName>
    const parts = key.split('__');
    if (parts.length < 3 || parts[0] !== 'mcp') return false;
    const slug = parts[1];
    const toolName = parts.slice(2).join('__');
    const serverId = slugToId.get(slug);
    if (serverId === undefined) return false;
    const allow = serverAllowList(profile, serverId);
    if (allow === null) return false;
    if (allow === '*') return true;
    return allow.includes(toolName);
  });
}

/**
 * Load a named profile from settings. Falls back to the default profile if
 * the requested name is not found.
 */
export function getProfile(name: string): Profile {
  const profiles = loadProfiles();
  return profiles[name] ?? profiles[DEFAULT_PROFILE_NAME] ?? {};
}
