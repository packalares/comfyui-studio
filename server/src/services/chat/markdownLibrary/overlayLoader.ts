// Generic overlay loader: user dir wins over bundled dir, by name.
// Each library (souls, skills, commands) calls this with its own parser
// function so the overlay logic lives in one place.

import fs from 'fs';
import path from 'path';
import { safeResolve, atomicWrite } from '../../../lib/fs.js';
import { isValidLibraryName } from './nameValidation.js';

/**
 * List all items from `bundledDir` and `userDir`, user entries winning on
 * name collision. `ext` is the file extension including the dot (`.md`).
 * `parser(name, raw)` converts raw file content into the typed item.
 * Returns items sorted alphabetically by name.
 */
export function listOverlay<T>(
  userDir: string,
  bundledDir: string,
  ext: string,
  parser: (name: string, raw: string) => T,
): T[] {
  const map = new Map<string, T>();

  for (const dir of [bundledDir, userDir]) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(ext)) continue;
      const name = entry.slice(0, -ext.length);
      if (!isValidLibraryName(name)) continue;
      const raw = readFileSafe(path.join(dir, entry));
      if (raw === null) continue;
      map.set(name, parser(name, raw));
    }
  }

  const items = [...map.values()] as Array<T & { name: string }>;
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/**
 * Load one item by name. User dir is checked first; bundled dir is the
 * fallback. Returns null when the item doesn't exist in either location.
 * `ext` is the file extension including the dot.
 */
export function loadOverlay<T>(
  userDir: string,
  bundledDir: string,
  name: string,
  ext: string,
  parser: (name: string, raw: string) => T,
): T | null {
  if (!isValidLibraryName(name)) return null;

  for (const dir of [userDir, bundledDir]) {
    try {
      const p = safeResolve(dir, `${name}${ext}`);
      const raw = readFileSafe(p);
      if (raw !== null) return parser(name, raw);
    } catch { /* safeResolve threw — skip */ }
  }
  return null;
}

/**
 * Write an item to the user dir. Creates the directory if needed.
 * Never writes to the bundled dir.
 */
export function writeUser(userDir: string, name: string, ext: string, body: string): void {
  if (!isValidLibraryName(name)) throw new Error(`Invalid library name: ${name}`);
  const p = safeResolve(userDir, `${name}${ext}`);
  atomicWrite(p, body);
}

/**
 * Delete an item from the user dir. Returns true when deleted.
 * Returns false when the file doesn't exist in the user dir (bundled-only
 * items cannot be deleted this way).
 */
export function deleteUser(userDir: string, name: string, ext: string): boolean {
  if (!isValidLibraryName(name)) throw new Error(`Invalid library name: ${name}`);
  let p: string;
  try { p = safeResolve(userDir, `${name}${ext}`); } catch { return false; }
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when the item exists only in the bundled dir (no user file).
 * Used to block DELETE on purely bundled seeds.
 */
export function isBundledOnlyItem(
  userDir: string,
  bundledDir: string,
  name: string,
  ext: string,
): boolean {
  if (!isValidLibraryName(name)) return false;
  try {
    const userPath = safeResolve(userDir, `${name}${ext}`);
    fs.accessSync(userPath, fs.constants.F_OK);
    return false; // user file exists
  } catch {
    try {
      const bundledPath = safeResolve(bundledDir, `${name}${ext}`);
      fs.accessSync(bundledPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function readFileSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
