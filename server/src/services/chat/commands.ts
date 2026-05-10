// Commands subsystem: registry, slash-command parser, and expander.
//
// Commands are single .md files, not folders.
// User dir overlays bundled dir: user file wins on name collision.

import path from 'path';
import os from 'os';
import type { UIMessage } from 'ai';
import { paths } from '../../config/paths.js';
import { currentConfigRootOverride } from '../../config/env.js';
import { parseFrontmatter } from './markdownLibrary/frontmatter.js';
import { isValidLibraryName } from './markdownLibrary/nameValidation.js';
import {
  listOverlay,
  loadOverlay,
  writeUser,
  deleteUser,
  isBundledOnlyItem,
} from './markdownLibrary/overlayLoader.js';

// ---------- Types ----------

export interface CommandFrontmatter {
  name?: string;
  description?: string;
  argument_hint?: string;
  [key: string]: unknown;
}

export interface Command {
  name: string;
  frontmatter: CommandFrontmatter;
  body: string;
  description: string;
  argumentHint: string;
}

export interface DetectedCommand {
  name: string;
  args: string;
}

// ---------- Paths ----------

export function getUserCommandsDir(): string {
  const configRoot = currentConfigRootOverride()
    ?? path.join(os.homedir(), '.config', 'comfyui-studio');
  return path.join(configRoot, 'commands');
}

export function getBundledCommandsDir(): string {
  return paths.bundledCommandsDir;
}

// ---------- Registry ----------

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

// ---------- Parser ----------

/**
 * Detect a slash command at the start of `message`.
 * Returns `{ name, args }` when the message begins with `/word`, or null.
 *
 * Leading whitespace is NOT trimmed — ` /foo` is intentionally not a command.
 * `args` has leading whitespace stripped; internal whitespace is kept.
 */
export function detectSlashCommand(message: string): DetectedCommand | null {
  const match = message.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1]!;
  const args = (match[2] ?? '').trimStart();
  return { name, args };
}

// ---------- Expander ----------

/**
 * Detect a slash command in the latest user message and expand it.
 * Returns a new messages array with the model-facing text replaced.
 * On unknown command, prepends an inline error note before the original text.
 * Only the LAST user message is inspected; older `/foo` text in history is
 * left intact. When no command is detected, returns the original array unchanged.
 */
export function expandLatestSlashCommand(messages: UIMessage[]): UIMessage[] {
  const lastIdx = messages.length - 1;
  if (lastIdx < 0) return messages;
  const last = messages[lastIdx]!;
  if (last.role !== 'user') return messages;

  const parts = (last.parts ?? []) as Array<{ type: string; text?: string }>;
  const textPart = parts.find(p => p.type === 'text');
  const rawText = textPart?.text ?? '';

  const detected = detectSlashCommand(rawText);
  if (!detected) return messages;

  const { name, args } = detected;

  let expandedText: string;
  try {
    expandedText = expandCommand(name, args);
  } catch {
    // Unknown command: inject an inline note and pass through the literal text.
    const available = listCommands().map(c => `/${c.name}`).join(', ') || '(none)';
    const note = `[Unknown command: /${name}. Available: ${available}. Continuing with the literal text.]\n\n`;
    expandedText = note + rawText;
  }

  const replacedParts = parts.map(p =>
    p.type === 'text' ? { ...p, text: expandedText } : p,
  );
  const replacedMsg: UIMessage = {
    ...last,
    parts: replacedParts as UIMessage['parts'],
  };

  return [...messages.slice(0, lastIdx), replacedMsg];
}
