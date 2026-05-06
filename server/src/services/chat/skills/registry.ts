// Skills registry: list, get, put, delete skill SKILL.md files.
//
// Skills live in folders: <skillsDir>/<name>/SKILL.md
// User dir overlays bundled dir: user file wins on name collision.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { paths } from '../../../config/paths.js';
import { currentConfigRootOverride } from '../../../config/env.js';
import { safeResolve, atomicWrite } from '../../../lib/fs.js';
import { parseFrontmatter } from '../markdownLibrary/frontmatter.js';
import { isValidLibraryName } from '../markdownLibrary/nameValidation.js';
import type { Skill, SkillFrontmatter, SkillIndex } from './types.js';

export function getUserSkillsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'skills');
}

export function getBundledSkillsDir(): string {
  return paths.bundledSkillsDir;
}

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function parseSkill(name: string, raw: string): Skill {
  const { frontmatter, body } = parseFrontmatter(raw);
  const fm = frontmatter as SkillFrontmatter;

  let description = '';
  if (typeof fm.description === 'string' && fm.description.length > 0) {
    description = fm.description;
  } else {
    const firstLine = body.split('\n').find(l => l.trim().length > 0) ?? '';
    const clean = firstLine.replace(/^#+\s*/, '').trim();
    description = clean.length > 120 ? clean.slice(0, 120) : clean;
  }

  const scripts = Array.isArray(fm.scripts)
    ? fm.scripts.filter((s): s is string => typeof s === 'string')
    : [];

  return { name, frontmatter: fm, body, description, scripts };
}

function loadSkillFromDir(dir: string, name: string): Skill | null {
  try {
    const skillFile = safeResolve(path.join(dir, name), 'SKILL.md');
    const raw = readFileSafe(skillFile);
    if (raw !== null) return parseSkill(name, raw);
  } catch { /* escaped or not found */ }
  return null;
}

/** List all skills, user dir wins over bundled on name collision. */
export function listSkills(): Skill[] {
  const map = new Map<string, Skill>();

  for (const dir of [getBundledSkillsDir(), getUserSkillsDir()]) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!isValidLibraryName(name)) continue;
      const skill = loadSkillFromDir(dir, name);
      if (skill) map.set(name, skill);
    }
  }

  const items = [...map.values()];
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/** Load a single skill by name. User dir checked first. */
export function getSkill(name: string): Skill | null {
  if (!isValidLibraryName(name)) return null;
  return loadSkillFromDir(getUserSkillsDir(), name)
    ?? loadSkillFromDir(getBundledSkillsDir(), name);
}

/** Return the markdown body of a skill, or null if not found. */
export function getSkillBody(name: string): string | null {
  return getSkill(name)?.body ?? null;
}

/** Write a SKILL.md to the user dir. Creates directory if needed. */
export function putSkill(name: string, body: string): void {
  if (!isValidLibraryName(name)) throw new Error(`Invalid skill name: ${name}`);
  const skillDir = path.join(getUserSkillsDir(), name);
  fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
  const skillFile = safeResolve(skillDir, 'SKILL.md');
  atomicWrite(skillFile, body);
}

/**
 * Delete a SKILL.md from the user dir. Returns true when deleted.
 * Returns false when no user file exists (bundled-only skills cannot be deleted).
 */
export function deleteSkill(name: string): boolean {
  if (!isValidLibraryName(name)) throw new Error(`Invalid skill name: ${name}`);
  const skillDir = path.join(getUserSkillsDir(), name);
  let skillFile: string;
  try { skillFile = safeResolve(skillDir, 'SKILL.md'); } catch { return false; }
  try {
    fs.unlinkSync(skillFile);
    return true;
  } catch {
    return false;
  }
}

/** Whether a skill exists only in the bundled dir. */
export function isSkillBundledOnly(name: string): boolean {
  if (!isValidLibraryName(name)) return false;
  const userSkill = loadSkillFromDir(getUserSkillsDir(), name);
  if (userSkill) return false;
  return loadSkillFromDir(getBundledSkillsDir(), name) !== null;
}

/** Compact index for embedding in system prompts. */
export function listSkillIndex(): SkillIndex[] {
  return listSkills().map(s => ({ name: s.name, description: s.description }));
}
