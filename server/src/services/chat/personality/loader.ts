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
import { safeResolve } from '../../../lib/fs.js';
import type { ParsedSoul } from './types.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Validate a soul name string before doing any path ops with it. */
export function isValidSoulName(name: string): boolean {
  return NAME_RE.test(name);
}

function parseSoul(name: string, raw: string): ParsedSoul {
  let frontmatter: Record<string, unknown> = {};
  let body = raw;

  // Parse YAML-ish frontmatter block: --- ... ---
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    const fmLines = (fmMatch[1] ?? '').split('\n');
    for (const line of fmLines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (key) frontmatter[key] = val;
    }
    body = (fmMatch[2] ?? '').trimStart();
  }

  let description = '';
  if (typeof frontmatter.description === 'string' && frontmatter.description.length > 0) {
    description = frontmatter.description;
  } else {
    // First non-blank line of the body, stripped of leading # and trimmed.
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

/** Absolute path to the bundled (read-only) personalities dir.
 *  Uses `paths.bundledPersonalitiesDir` (file-relative) rather than
 *  `paths.dataDir` so the env override DATA_DIR (which redirects mutable
 *  state on the pod) does not also redirect the bundled seeds. */
export function getBundledPersonalitiesDir(): string {
  return paths.bundledPersonalitiesDir;
}

function getUserSoulsDir(): string {
  return path.join(getUserPersonalitiesDir(), 'souls');
}

function getBundledSoulsDir(): string {
  return path.join(getBundledPersonalitiesDir(), 'souls');
}

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * List all souls, merging user dir over bundled (user file wins by name).
 * Returns an array sorted alphabetically by name.
 */
export function listSouls(): ParsedSoul[] {
  const soulsMap = new Map<string, ParsedSoul>();

  // Load bundled first, then user overwrites.
  for (const dir of [getBundledSoulsDir(), getUserSoulsDir()]) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.slice(0, -3);
      if (!isValidSoulName(name)) continue;
      const raw = readFileSafe(path.join(dir, entry));
      if (raw === null) continue;
      soulsMap.set(name, parseSoul(name, raw));
    }
  }

  return [...soulsMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load a single soul by name, user dir wins over bundled.
 * Returns null if not found in either location.
 */
export function loadSoul(name: string): ParsedSoul | null {
  if (!isValidSoulName(name)) return null;

  for (const dir of [getUserSoulsDir(), getBundledSoulsDir()]) {
    try {
      const p = safeResolve(dir, `${name}.md`);
      const raw = readFileSafe(p);
      if (raw !== null) return parseSoul(name, raw);
    } catch { /* safeResolve threw — skip */ }
  }
  return null;
}

/**
 * Return the body text of a soul. Used when composing the system prompt.
 * Falls back to empty string when not found.
 */
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

/**
 * Write a soul file to the user dir. Creates the directory if needed.
 * Never writes to the bundled dir.
 */
export function writeSoul(name: string, body: string): void {
  if (!isValidSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  const dir = getUserSoulsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = safeResolve(dir, `${name}.md`);
  fs.writeFileSync(p, body, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Delete a soul from the user dir. Returns true when deleted.
 * Returns false when the file doesn't exist in the user dir
 * (bundled-only souls cannot be deleted this way).
 */
export function deleteSoul(name: string): boolean {
  if (!isValidSoulName(name)) throw new Error(`Invalid soul name: ${name}`);
  const dir = getUserSoulsDir();
  let p: string;
  try { p = safeResolve(dir, `${name}.md`); } catch { return false; }
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a soul exists only in the bundled dir (no user override).
 * Used to block DELETE on purely bundled seeds.
 */
export function isBundledOnly(name: string): boolean {
  if (!isValidSoulName(name)) return false;
  const userDir = getUserSoulsDir();
  try {
    const p = safeResolve(userDir, `${name}.md`);
    fs.accessSync(p, fs.constants.F_OK);
    return false; // user file exists
  } catch {
    // No user file. Check bundled.
    const bundledDir = getBundledSoulsDir();
    try {
      const p = safeResolve(bundledDir, `${name}.md`);
      fs.accessSync(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------- Memory ----------

function getUserMemoryPath(): string {
  return path.join(getUserPersonalitiesDir(), 'memory.md');
}

function getBundledMemoryPath(): string {
  return path.join(getBundledPersonalitiesDir(), 'memory.md');
}

/**
 * Load memory.md. User file is authoritative; if it doesn't exist yet,
 * copy the bundled stub and return it.
 */
export function loadMemoryBody(): string {
  const userPath = getUserMemoryPath();
  const existing = readFileSafe(userPath);
  if (existing !== null) return existing;

  // First access: initialise from bundled stub.
  const stub = readFileSafe(getBundledMemoryPath()) ?? '';
  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(userPath, stub, { encoding: 'utf8', mode: 0o600 });
  } catch { /* non-fatal */ }
  return stub;
}

/**
 * Write memory.md atomically to the user dir.
 */
export function writeMemoryBody(body: string): void {
  const userPath = getUserMemoryPath();
  const dir = path.dirname(userPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${userPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, userPath);
}

/**
 * Append a single timestamped fact to memory.md.
 * Format: `- YYYY-MM-DD: <fact>\n`
 */
export function appendMemoryFact(fact: string): void {
  const date = new Date().toISOString().slice(0, 10);
  const existing = loadMemoryBody();
  const line = `- ${date}: ${fact}\n`;
  // Ensure trailing newline before appending.
  const base = existing.length > 0 && !existing.endsWith('\n')
    ? existing + '\n'
    : existing;
  writeMemoryBody(base + line);
}
