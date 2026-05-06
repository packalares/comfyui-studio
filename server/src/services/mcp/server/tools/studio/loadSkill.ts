// MCP tool: load the full body of a named skill.
// The model calls this when the user's request matches a skill description.

import { z } from 'zod';
import { getSkillBody } from '../../../../chat/skills/index.js';

export const description =
  'Load the full body of a named skill. Call this when the user asks for help with something a skill description matches. Returns the markdown body so you can follow its instructions for the rest of the conversation.';

export const inputShape = {
  name: z.string().min(1).max(64).describe('Skill name as listed in the system prompt.'),
};

export interface LoadSkillArgs {
  name: string;
}

export async function run(args: LoadSkillArgs): Promise<string> {
  const body = getSkillBody(args.name);
  if (body === null) throw new Error(`Skill not found: ${args.name}`);
  return body;
}
