// Commands registry: list, get, put, delete, expand command .md files.
//
// Commands are single .md files, not folders.
// User dir overlays bundled dir: user file wins on name collision.

import path from 'path';
import os from 'os';
import { paths } from '../../../config/paths.js';
import { currentConfigRootOverride } from '../../../config/env.js';
import { parseFrontmatter } from '../markdownLibrary/frontmatter.js';
import { isValidLibraryName } from '../markdownLibrary/nameValidation.js';
import {
  listOverlay,
  loadOverlay,
  writeUser,
  deleteUser,
  isBundledOnlyItem,
} from '../markdownLibrary/overlayLoader.js';
import type { Command, CommandFrontmatter } from './types.js';

export function getUserCommandsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'commands');
}

export function getBundledCommandsDir(): string {
  return paths.bundledCommandsDir;
}

function parseCommand(name: string, raw: string): Command {
  const { frontmatter, body } = parseFrontmatter(raw);
  const fm = frontmatter as CommandFrontmatter;

  let description = '';
  if (typeof fm.description === 'string' && fm.description.length > 0) {
    description = fm.description;
  } else {
    const firstLine = body.split('\n').find(l => l.trim().length > 0) ?? '';
    const clean = firstLine.replace(/^#+\s*/, '').trim();
    description = clean.length > 120 ? clean.slice(0, 120) : clean;
  }

  const argumentHint = typeof fm.argument_hint === 'string' ? fm.argument_hint : '';

  return { name, frontmatter: fm, body, description, argumentHint };
}

/** List all commands, user dir wins over bundled on name collision. */
export function listCommands(): Command[] {
  return listOverlay(getUserCommandsDir(), getBundledCommandsDir(), '.md', parseCommand);
}

/** Load a single command by name. User dir checked first. */
export function getCommand(name: string): Command | null {
  return loadOverlay(getUserCommandsDir(), getBundledCommandsDir(), name, '.md', parseCommand);
}

/** Write a command to the user dir. Creates directory if needed. */
export function putCommand(name: string, body: string): void {
  if (!isValidLibraryName(name)) throw new Error(`Invalid command name: ${name}`);
  writeUser(getUserCommandsDir(), name, '.md', body);
}

/**
 * Delete a command from the user dir. Returns true when deleted.
 * Returns false when the file doesn't exist in the user dir.
 */
export function deleteCommand(name: string): boolean {
  if (!isValidLibraryName(name)) throw new Error(`Invalid command name: ${name}`);
  return deleteUser(getUserCommandsDir(), name, '.md');
}

/** Whether a command exists only in the bundled dir. */
export function isCommandBundledOnly(name: string): boolean {
  return isBundledOnlyItem(getUserCommandsDir(), getBundledCommandsDir(), name, '.md');
}

/**
 * Expand a command: load its body, substitute `$ARGUMENTS` with `args`.
 * Throws when the command is not found.
 */
export function expandCommand(name: string, args: string): string {
  const cmd = getCommand(name);
  if (!cmd) throw new Error(`Unknown command: ${name}`);
  return cmd.body.replace(/\$ARGUMENTS/g, args);
}
