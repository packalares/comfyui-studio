// Generic overlay registry factory. Encapsulates list/get/put/delete over
// an overlay (user-dir wins over bundled dir) so the three consumer
// subsystems (skills, commands, souls) don't duplicate the same pattern.
//
// `kind: 'folder'` — item lives at `<dir>/<name>/<filename>` (skills use SKILL.md)
// `kind: 'file'`   — item lives at `<dir>/<name><ext>` (commands + souls use .md)

import fs from 'fs';
import path from 'path';
import { safeResolve, atomicWrite } from '../../../lib/fs.js';
import { isValidLibraryName } from './nameValidation.js';
import { parseFrontmatter } from './frontmatter.js';

export interface RegistryItem {
  name: string;
  content: string;
  frontmatter: Record<string, unknown>;
  source: 'user' | 'bundled';
}

export interface RegistryOpts {
  kind: 'folder' | 'file';
  /** For kind=folder: the filename inside the subfolder (e.g. 'SKILL.md').
   *  For kind=file: the extension including dot (e.g. '.md'). */
  filename: string;
  userDir: () => string;
  bundledDir: () => string;
}

export interface Registry<T extends RegistryItem> {
  list(): T[];
  get(name: string): T | null;
  put(name: string, content: string): void;
  delete(name: string): boolean;
}

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function resolveItemPath(dir: string, name: string, opts: RegistryOpts): string {
  if (opts.kind === 'folder') {
    return safeResolve(path.join(dir, name), opts.filename);
  }
  return safeResolve(dir, `${name}${opts.filename}`);
}

function loadOne<T extends RegistryItem>(
  dir: string,
  name: string,
  source: 'user' | 'bundled',
  opts: RegistryOpts,
  parse: (name: string, raw: string, source: 'user' | 'bundled') => T,
): T | null {
  try {
    const p = resolveItemPath(dir, name, opts);
    const raw = readSafe(p);
    if (raw === null) return null;
    return parse(name, raw, source);
  } catch {
    return null;
  }
}

/**
 * Create a typed overlay registry. The `parse` function converts raw file
 * content into your domain item type (which must extend `RegistryItem`).
 */
export function createMarkdownRegistry<T extends RegistryItem>(
  opts: RegistryOpts,
  parse: (name: string, raw: string, source: 'user' | 'bundled') => T,
): Registry<T> {
  function list(): T[] {
    const map = new Map<string, T>();
    for (const [dir, source] of [
      [opts.bundledDir(), 'bundled'] as const,
      [opts.userDir(), 'user'] as const,
    ]) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const entryName = opts.kind === 'folder'
          ? (entry.isDirectory() ? entry.name : null)
          : (entry.isFile() ? entry.name.slice(0, -opts.filename.length) : null);
        if (!entryName) continue;
        if (!isValidLibraryName(entryName)) continue;
        // For file kind, only consider entries that end with the extension.
        if (opts.kind === 'file' && !entry.name.endsWith(opts.filename)) continue;
        const item = loadOne(dir, entryName, source, opts, parse);
        if (item) map.set(entryName, item);
      }
    }
    const items = [...map.values()];
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  }

  function get(name: string): T | null {
    if (!isValidLibraryName(name)) return null;
    return (
      loadOne(opts.userDir(), name, 'user', opts, parse) ??
      loadOne(opts.bundledDir(), name, 'bundled', opts, parse)
    );
  }

  function put(name: string, content: string): void {
    if (!isValidLibraryName(name)) throw new Error(`Invalid name: ${name}`);
    const userDir = opts.userDir();
    if (opts.kind === 'folder') {
      const itemDir = path.join(userDir, name);
      fs.mkdirSync(itemDir, { recursive: true, mode: 0o700 });
      const p = safeResolve(itemDir, opts.filename);
      atomicWrite(p, content);
    } else {
      const p = safeResolve(userDir, `${name}${opts.filename}`);
      atomicWrite(p, content);
    }
  }

  function deleteItem(name: string): boolean {
    if (!isValidLibraryName(name)) throw new Error(`Invalid name: ${name}`);
    const userDir = opts.userDir();
    let p: string;
    try {
      p = opts.kind === 'folder'
        ? safeResolve(path.join(userDir, name), opts.filename)
        : safeResolve(userDir, `${name}${opts.filename}`);
    } catch { return false; }
    try { fs.unlinkSync(p); return true; } catch { return false; }
  }

  return { list, get, put, delete: deleteItem };
}

export { parseFrontmatter };
