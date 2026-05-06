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
import { listSkillIndex } from '../skills/registry.js';

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
  const skills = listSkillIndex();

  const parts: string[] = [];
  if (soulBody.trim().length > 0) parts.push(soulBody);
  if (memoryBody.trim().length > 0) {
    parts.push(`# What I know about the user\n\n${memoryBody}`);
  }
  if (skills.length > 0) {
    const lines = skills.map(s => `- ${s.name} — ${s.description}`).join('\n');
    parts.push(`# Skills available (load when relevant via studio_load_skill)\n${lines}`);
  }
  return parts.join('\n\n---\n\n');
}
