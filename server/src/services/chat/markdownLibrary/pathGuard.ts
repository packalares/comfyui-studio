// Path helpers for library directories (skills, commands, souls).
// Centralises the safeResolve + name validation guard in one place.

import { safeResolve } from '../../../lib/fs.js';
import { isValidLibraryName } from './nameValidation.js';

/**
 * Resolve a safe absolute path to `<libraryDir>/<name><ext>`.
 * Throws when `name` fails validation or the resolved path would escape
 * `libraryDir` (path-traversal guard via safeResolve).
 */
export function safeLibraryPath(libraryDir: string, name: string, ext: string): string {
  if (!isValidLibraryName(name)) {
    throw new Error(`Invalid library name: ${name}`);
  }
  return safeResolve(libraryDir, `${name}${ext}`);
}
