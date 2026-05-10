// Personality subsystem: souls, memory, pending soul-edit queue, and system-prompt assembly.
//
// User dir (~/.config/comfyui-studio/personalities/) wins over bundled seeds.
// Edits always go to user dir; bundled files are never written.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { paths } from '../../config/paths.js';
import { currentConfigRootOverride } from '../../config/env.js';
import { atomicWrite, safeResolve } from '../../lib/fs.js';
import {
  parseFrontmatter,
  isValidLibraryName,
  listOverlay,
  loadOverlay,
  writeUser,
  deleteUser,
  isBundledOnlyItem,
} from './markdownLibrary/index.js';
import { listSkills } from './skills.js';
import { listCommands } from './commands.js';
import { getConversation } from '../../lib/db/chat.repo.js';

// ---------- Types ----------

export interface SoulFrontmatter {
  description?: string;
  [key: string]: unknown;
}

export interface ParsedSoul {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
  description: string;
}

export interface PendingEdit {
  id: string;
  soulName: string;
  reason: string;
  currentSection: string | null;
  proposedReplacement: string;
  createdAt: number;
}

export interface PersonalitySummarySoul {
  name: string;
  description: string;
}

export interface PersonalitySummarySkill {
  name: string;
  description: string;
  scripts: string[];
}

export interface PersonalitySummaryCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface PersonalitySummary {
  souls: PersonalitySummarySoul[];
  skills: PersonalitySummarySkill[];
  commands: PersonalitySummaryCommand[];
  defaultSoul: string | null;
  edits: PendingEdit[];
}

// ---------- Paths ----------

/** Absolute path to the user-writable personalities dir.
 *  Resolves at call-time so vitest fixtures that set STUDIO_CONFIG_ROOT per-test get the correct path. */
export function getUserPersonalitiesDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'personalities');
}

export function getBundledPersonalitiesDir(): string {
  return paths.bundledPersonalitiesDir;
}

function getUserSoulsDir(): string {
  return path.join(getUserPersonalitiesDir(), 'souls');
}

function getBundledSoulsDir(): string {
  return path.join(getBundledPersonalitiesDir(), 'souls');
}

function getUserMemoryPath(): string {
  return path.join(getUserPersonalitiesDir(), 'memory.md');
}

function getBundledMemoryPath(): string {
  return path.join(getBundledPersonalitiesDir(), 'memory.md');
}

function getPendingSoulEditsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'personalities', 'pending-soul-edits');
}

function getSoulBackupsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'personalities', 'soul-backups');
}

function editFilePath(id: string): string {
  const dir = getPendingSoulEditsDir();
  return safeResolve(dir, `${id}.json`);
}

// ---------- Soul validation ----------

export function isValidSoulName(name: string): boolean {
  return isValidLibraryName(name);
}

// ---------- Soul registry ----------

function parseSoul(name: string, raw: string): ParsedSoul {
  const { frontmatter, body } = parseFrontmatter(raw);

  let description = '';
  if (typeof frontmatter.description === 'string' && frontmatter.description.length > 0) {
    description = frontmatter.description;
  } else {
    const firstLine = body.split('\n').find(l => l.trim().length > 0) ?? '';
    const clean = firstLine.replace(/^#+\s*/, '').trim();
    description = clean.length > 80 ? clean.slice(0, 80) : clean;
  }

  return { name, frontmatter, body, description };
}

export function listSouls(): ParsedSoul[] {
  return listOverlay(getUserSoulsDir(), getBundledSoulsDir(), '.md', parseSoul);
}

export function loadSoul(name: string): ParsedSoul | null {
  return loadOverlay(getUserSoulsDir(), getBundledSoulsDir(), name, '.md', parseSoul);
}

export function loadSoulBody(name: string): string {
  return loadSoul(name)?.body ?? '';
}

/**
 * Name of the default soul. Returns 'default' if that file exists in either
 * dir, otherwise the alphabetically first soul name, otherwise null.
 */
export function getDefaultSoulName(): string | null {
  const all = listSouls();
  if (all.length === 0) return null;
  const hasDefault = all.some(s => s.name === 'default');
  return hasDefault ? 'default' : (all[0]?.name ?? null);
}

export function writeSoul(name: string, body: string): void {
  if (!isValidSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  writeUser(getUserSoulsDir(), name, '.md', body);
}

export function deleteSoul(name: string): boolean {
  if (!isValidSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  return deleteUser(getUserSoulsDir(), name, '.md');
}

export function isBundledOnly(name: string): boolean {
  return isBundledOnlyItem(getUserSoulsDir(), getBundledSoulsDir(), name, '.md');
}

// ---------- Memory ----------

/** Load memory.md. User file is authoritative; if absent, copy the bundled stub. */
export function loadMemoryBody(): string {
  const userPath = getUserMemoryPath();
  try {
    return fs.readFileSync(userPath, 'utf8');
  } catch { /* not yet written */ }

  const stub = (() => { try { return fs.readFileSync(getBundledMemoryPath(), 'utf8'); } catch { return ''; } })();
  try { atomicWrite(userPath, stub); } catch { /* non-fatal */ }
  return stub;
}

export function writeMemoryBody(body: string): void {
  atomicWrite(getUserMemoryPath(), body);
}

/**
 * Append a single timestamped fact to memory.md.
 * Format: `- YYYY-MM-DD: <fact>\n`
 *
 * No-op when the same fact (case-insensitive, ignoring date) is already
 * present — prevents duplicate accumulation when the model fires multiple times.
 */
export function appendMemoryFact(fact: string): void {
  const trimmed = fact.trim();
  if (trimmed.length === 0) return;

  const existing = loadMemoryBody();
  const factKey = trimmed.toLowerCase();
  const alreadyHas = existing.split('\n').some(rawLine => {
    // Accept any markdown bullet (`-`, `*`, `+`) so hand-edited files using
    // non-default style still participate in dedup.
    const m = rawLine.match(/^[-*+]\s+\d{4}-\d{2}-\d{2}:\s*(.+)$/);
    return m !== null && m[1].trim().toLowerCase() === factKey;
  });
  if (alreadyHas) return;

  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${date}: ${trimmed}\n`;
  const base = existing.length > 0 && !existing.endsWith('\n')
    ? existing + '\n'
    : existing;
  writeMemoryBody(base + line);
}

// ---------- Pending soul edits ----------

function makeId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export function listPendingEdits(): PendingEdit[] {
  const dir = getPendingSoulEditsDir();
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }

  const results: PendingEdit[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const p = safeResolve(dir, entry);
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as PendingEdit;
      results.push(parsed);
    } catch { /* skip corrupt files */ }
  }
  return results.sort((a, b) => a.createdAt - b.createdAt);
}

export function getPendingEdit(id: string): PendingEdit | null {
  try {
    const p = editFilePath(id);
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as PendingEdit;
  } catch {
    return null;
  }
}

export function createPendingEdit(
  input: Omit<PendingEdit, 'id' | 'createdAt'>,
): PendingEdit {
  const edit: PendingEdit = {
    ...input,
    id: makeId(),
    createdAt: Date.now(),
  };
  const dir = getPendingSoulEditsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = safeResolve(dir, `${edit.id}.json`);
  fs.writeFileSync(p, JSON.stringify(edit, null, 2), { encoding: 'utf8', mode: 0o600 });
  return edit;
}

export function deletePendingEdit(id: string): boolean {
  try {
    const p = editFilePath(id);
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export function applyPendingEdit(id: string): { ok: boolean; soulName: string } {
  const edit = getPendingEdit(id);
  if (!edit) return { ok: false, soulName: '' };

  const body = loadSoulBody(edit.soulName);

  // If the section to replace is given but not found in the body, refuse to
  // apply. Ambiguous replacement could corrupt the soul silently.
  if (edit.currentSection !== null && !body.includes(edit.currentSection)) {
    return { ok: false, soulName: edit.soulName };
  }

  backupSoul(edit.soulName, body);

  const newBody = edit.currentSection === null
    // Append mode: add the proposed text after a blank line separator.
    ? (body.trimEnd() + '\n\n' + edit.proposedReplacement)
    // Replace mode: swap the first occurrence of the matched section.
    : body.replace(edit.currentSection, edit.proposedReplacement);

  writeSoul(edit.soulName, newBody);
  deletePendingEdit(id);
  return { ok: true, soulName: edit.soulName };
}

function backupSoul(soulName: string, body: string): void {
  const backupsDir = getSoulBackupsDir();
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const timestamp = Date.now();
  const filename = `${timestamp}-${soulName}.md`;
  const p = safeResolve(backupsDir, filename);
  fs.writeFileSync(p, body, { encoding: 'utf8', mode: 0o600 });
}

// ---------- Active soul resolution ----------

/**
 * Resolve the soul name in effect for a conversation.
 * Reads conversations.soul_name; falls back to the default soul when null.
 * Returns null when no soul exists at all.
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

// ---------- System prompt assembly ----------

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
    // so the model knows it can chain studio_run_skill_script after loading.
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

// ---------- Personality summary ----------

export function getPersonalitySummary(): PersonalitySummary {
  return {
    souls: listSouls().map(s => ({ name: s.name, description: s.description })),
    skills: listSkills().map(s => ({
      name: s.name,
      description: s.description,
      scripts: s.scripts,
    })),
    commands: listCommands().map(c => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
    })),
    defaultSoul: getDefaultSoulName(),
    edits: listPendingEdits(),
  };
}
