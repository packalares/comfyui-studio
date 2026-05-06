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
  // Conversation context is not threaded into MCP tool calls (see toolRegistry.ts
  // — run() receives only the parsed args object). The caller must therefore
  // supply soulName explicitly; there is no ambient "active soul" available here.
  soulName: z.string()
    .describe('Which soul to edit. Must be a valid soul name (alphanumeric + hyphens).'),
};

export interface ProposeSoulEditArgs {
  reason: string;
  currentSection?: string | null;
  proposedReplacement: string;
  soulName: string;
}

export async function run(
  args: ProposeSoulEditArgs,
): Promise<{ ok: boolean; pendingEditId?: string; message: string }> {
  const { soulName, reason, proposedReplacement } = args;
  const currentSection = args.currentSection ?? null;

  if (!isValidSoulName(soulName)) {
    return { ok: false, message: `Invalid soul name: "${soulName}"` };
  }
  if (loadSoul(soulName) === null) {
    return { ok: false, message: `Soul not found: "${soulName}"` };
  }

  const edit = createPendingEdit({ soulName, reason, currentSection, proposedReplacement });
  return { ok: true, pendingEditId: edit.id, message: 'Proposal queued for user review.' };
}
