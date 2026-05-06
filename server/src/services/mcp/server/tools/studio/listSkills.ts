// MCP tool: list available skills with their descriptions.
// The system prompt already includes the index; this refreshes mid-conversation.

import { listSkillIndex } from '../../../../chat/skills/index.js';
import type { SkillIndex } from '../../../../chat/skills/index.js';

export const description =
  'List all available skills with their descriptions. Use this when you are unsure whether a skill exists for the user request. The system prompt already contains the index, so this is mostly for refresh after the user installs a new skill mid-conversation.';

export const inputShape = {};

export async function run(_args: Record<string, never>): Promise<SkillIndex[]> {
  return listSkillIndex();
}
