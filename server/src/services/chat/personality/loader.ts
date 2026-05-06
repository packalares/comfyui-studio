// Loads soul and memory files from the overlay filesystem.
//
// User dir (~/.config/comfyui-studio/personalities/) wins over bundled seeds
// (server/data/personalities/). Edits always go to user dir; bundled files
// are never written.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { paths } from '../../../config/paths.js';
import { currentConfigRootOverride } from '../../../config/env.js';
import { atomicWrite } from '../../../lib/fs.js';
import {
  parseFrontmatter,
  isValidLibraryName,
  listOverlay,
  loadOverlay,
  writeUser,
  deleteUser,
  isBundledOnlyItem,
} from '../markdownLibrary/index.js';
import type { ParsedSoul } from './types.js';

/** Validate a soul name string before doing any path ops with it. */
export function isValidSoulName(name: string): boolean {
  return isValidLibraryName(name);
}

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

/**
 * Absolute path to the user-writable personalities dir.
 * Resolves through `currentConfigRootOverride()` at call-time so vitest
 * fixtures that set `STUDIO_CONFIG_ROOT` per-test get the correct path.
 */
export function getUserPersonalitiesDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'personalities');
}

/** Absolute path to the bundled (read-only) personalities dir. */
export function getBundledPersonalitiesDir(): string {
  return paths.bundledPersonalitiesDir;
}

function getUserSoulsDir(): string {
  return path.join(getUserPersonalitiesDir(), 'souls');
}

function getBundledSoulsDir(): string {
  return path.join(getBundledPersonalitiesDir(), 'souls');
}

/** List all souls, merging user dir over bundled (user file wins by name). */
export function listSouls(): ParsedSoul[] {
  return listOverlay(getUserSoulsDir(), getBundledSoulsDir(), '.md', parseSoul);
}

/** Load a single soul by name, user dir wins over bundled. */
export function loadSoul(name: string): ParsedSoul | null {
  return loadOverlay(getUserSoulsDir(), getBundledSoulsDir(), name, '.md', parseSoul);
}

/** Return the body text of a soul. Falls back to empty string when not found. */
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

/** Write a soul file to the user dir. Creates the directory if needed. */
export function writeSoul(name: string, body: string): void {
  if (!isValidSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  writeUser(getUserSoulsDir(), name, '.md', body);
}

/**
 * Delete a soul from the user dir. Returns true when deleted.
 * Returns false when the file doesn't exist in the user dir.
 */
export function deleteSoul(name: string): boolean {
  if (!isValidSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  return deleteUser(getUserSoulsDir(), name, '.md');
}

/** Whether a soul exists only in the bundled dir (no user override). */
export function isBundledOnly(name: string): boolean {
  return isBundledOnlyItem(getUserSoulsDir(), getBundledSoulsDir(), name, '.md');
}

// ---------- Memory ----------

function getUserMemoryPath(): string {
  return path.join(getUserPersonalitiesDir(), 'memory.md');
}

function getBundledMemoryPath(): string {
  return path.join(getBundledPersonalitiesDir(), 'memory.md');
}

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

/** Write memory.md atomically to the user dir. */
export function writeMemoryBody(body: string): void {
  atomicWrite(getUserMemoryPath(), body);
}

/**
 * Append a single timestamped fact to memory.md.
 * Format: `- YYYY-MM-DD: <fact>\n`
 */
export function appendMemoryFact(fact: string): void {
  const date = new Date().toISOString().slice(0, 10);
  const existing = loadMemoryBody();
  const line = `- ${date}: ${fact}\n`;
  const base = existing.length > 0 && !existing.endsWith('\n')
    ? existing + '\n'
    : existing;
  writeMemoryBody(base + line);
}
