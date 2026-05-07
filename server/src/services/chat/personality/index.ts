// Public API for the personality subsystem (souls + memory).
//
// The chat route calls `resolveSystemPrompt` when starting a stream; the
// personality routes call the soul/memory helpers directly.

export {
  listSouls,
  loadSoul,
  loadSoulBody,
  writeSoul,
  deleteSoul,
  isBundledOnly,
  getDefaultSoulName,
  isValidSoulName,
  getUserPersonalitiesDir,
  getBundledPersonalitiesDir,
} from './loader.js';

export { loadMemoryBody, writeMemoryBody, appendMemoryFact } from './loader.js';

export type { ParsedSoul } from './types.js';

import { loadSoulBody, getDefaultSoulName, loadMemoryBody } from './loader.js';
import { listSkills } from '../skills/registry.js';
import { getConversation } from '../../../lib/db/chat.repo.js';

/**
 * Resolve the soul name in effect for a conversation.
 * Reads `conversations.soul_name`; falls back to the default soul when the
 * column is null (chat created before per-conversation soul was set, or the
 * user explicitly cleared it). Returns null when no soul exists at all.
 */
export function getActiveSoulName(conversationId: string | undefined): string | null {
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return getDefaultSoulName();
  }
  const conv = getConversation(conversationId);
  const explicit = conv?.soul_name;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return getDefaultSoulName();
}

/**
 * Compose the system prompt from a soul, current memory, and the skills index.
 *
 * Resolution order:
 *   1. Use soulName if provided and the soul exists.
 *   2. Fall back to the default soul (alphabetically first or 'default').
 *   3. If no soul at all, use empty string.
 * Memory is appended after a separator when non-empty.
 * Skills index is appended last when any skills are available.
 */
export function resolveSystemPrompt(soulName: string | null): string {
  const resolvedName = soulName ?? getDefaultSoulName();
  const soulBody = resolvedName ? loadSoulBody(resolvedName) : '';
  const memoryBody = loadMemoryBody();
  const skills = listSkills();

  const parts: string[] = [];
  if (soulBody.trim().length > 0) parts.push(soulBody);
  if (memoryBody.trim().length > 0) {
    parts.push(`# What I know about the user\n\n${memoryBody}`);
  }
  if (skills.length > 0) {
    // Skills with declared scripts get a `(scripts: foo.py, bar.sh)` suffix
    // so the model knows it can chain `studio_run_skill_script` after
    // loading the skill body. Skills without scripts read identically to
    // the older format.
    const lines = skills.map(s => {
      const base = `- ${s.name} — ${s.description}`;
      if (s.scripts.length === 0) return base;
      return `${base} (scripts: ${s.scripts.join(', ')})`;
    }).join('\n');
    parts.push(
      `# Skills available (load via studio_load_skill, run scripts via studio_run_skill_script)\n${lines}`,
    );
  }
  return parts.join('\n\n---\n\n');
}
