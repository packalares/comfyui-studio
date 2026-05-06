// snapshot(profileName): builds a filtered StudioTool map for the given
// profile by pulling the full namespaced tool set from McpClientRegistry and
// applying the profile allow-list.

import type { StudioTool } from '../../chat/tools/defineTool.js';
import { getProfile, filterByProfile } from './profiles.js';
import { getRegistry } from './index.js';

/**
 * Return the tool map visible to the LLM for the given profile.
 *
 * Only tools whose server is present in the profile (and passes the tool-name
 * allow-list) are included. If the profile is empty or the server is absent,
 * none of that server's tools appear.
 *
 * Calling `snapshot('studio-chat-default')` on an empty default profile
 * returns `{}`.
 */
export async function snapshot(
  profileName: string,
): Promise<Record<string, StudioTool>> {
  const registry = getRegistry();
  const allTools = await registry.getAllTools();
  const profile = getProfile(profileName);
  const keys = Object.keys(allTools);
  const allowed = filterByProfile(keys, profile);
  const out: Record<string, StudioTool> = {};
  for (const key of allowed) {
    out[key] = allTools[key];
  }
  return out;
}
