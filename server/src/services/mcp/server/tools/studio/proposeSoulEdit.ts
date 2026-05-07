// Studio MCP tool: propose a change to a soul file for user review.
// The model should use this sparingly — only when user corrections or patterns
// suggest the soul genuinely needs to evolve. Changes are queued as pending
// edits; nothing is applied until the user accepts via the API.

import { z } from 'zod';
import { createPendingEdit } from '../../../../chat/personality/pendingEdits.js';
import { loadSoul, isValidSoulName } from '../../../../chat/personality/loader.js';

export const description =
  'Propose a change to your current soul (identity/instructions). The user reviews and accepts/rejects. Use sparingly — only when you have meaningful evidence the soul should evolve based on user corrections.';

export const inputShape = {
  reason: z.string().min(10).max(500)
    .describe('Why this change is being proposed (cite user corrections or patterns).'),
  currentSection: z.string().max(2000).nullable().optional()
    .describe('Exact text from the current soul to replace. Null/omitted = append at end.'),
  proposedReplacement: z.string().min(1).max(5000)
    .describe('New text. Markdown, no frontmatter.'),
  // Optional: the chat-side wrapper in services/chat/tools/index.ts injects
  // the active conversation's `soul_name` when the model omits this field.
  // External MCP clients (no conversation context) MUST supply it explicitly
  // — `run()` rejects calls where soulName is missing.
  soulName: z.string().optional()
    .describe('Which soul to edit. Defaults to the active conversation\'s soul when called from chat.'),
};

export interface ProposeSoulEditArgs {
  reason: string;
  currentSection?: string | null;
  proposedReplacement: string;
  soulName?: string;
}

export async function run(
  args: ProposeSoulEditArgs,
): Promise<{ ok: boolean; pendingEditId?: string; message: string }> {
  const { soulName, reason, proposedReplacement } = args;
  const currentSection = args.currentSection ?? null;

  if (typeof soulName !== 'string' || soulName.length === 0) {
    return {
      ok: false,
      message: 'soulName is required. Pass the soul to edit explicitly when calling outside of a chat conversation.',
    };
  }
  if (!isValidSoulName(soulName)) {
    return { ok: false, message: `Invalid soul name: "${soulName}"` };
  }
  if (loadSoul(soulName) === null) {
    return { ok: false, message: `Soul not found: "${soulName}"` };
  }

  const edit = createPendingEdit({ soulName, reason, currentSection, proposedReplacement });
  return { ok: true, pendingEditId: edit.id, message: 'Proposal queued for user review.' };
}
