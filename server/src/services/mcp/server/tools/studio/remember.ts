// Studio MCP tool: persist a durable user fact to memory.md.

import { z } from 'zod';
import { appendMemoryFact } from '../../../../chat/personality/index.js';

export const description =
  'Persist a fact about the user that should survive across conversations. Use sparingly — only for genuinely durable preferences or facts the user has explicitly shared.';

export const inputShape = {
  fact: z.string().min(1).max(500).describe('Single durable fact, one sentence.'),
};

export interface RememberArgs {
  fact: string;
}

export async function run(args: RememberArgs): Promise<{ ok: boolean; persisted: string }> {
  appendMemoryFact(args.fact);
  return { ok: true, persisted: args.fact };
}
