// Slash-command expansion for the chat pipeline.
// Takes the latest user message from a UIMessage array and expands any
// slash command found at the start of the text before the model sees it.

import type { UIMessage } from 'ai';
import { detectSlashCommand } from './parser.js';
import { expandCommand, listCommands } from './registry.js';

/**
 * Detect a slash command in the latest user message and expand it.
 * Returns a new messages array with the model-facing text replaced.
 * On unknown command, prepends an inline error note before the original text.
 * Old messages with `/foo` text in history are untouched — only the LAST
 * user message is inspected.
 * When no command is detected, returns the original array unchanged.
 */
export function expandLatestSlashCommand(messages: UIMessage[]): UIMessage[] {
  const lastIdx = messages.length - 1;
  if (lastIdx < 0) return messages;
  const last = messages[lastIdx]!;
  if (last.role !== 'user') return messages;

  // Extract text from the first text part (same pattern as lastUserText).
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

  // Replace only the text part; leave other part types (files, images) intact.
  const replacedParts = parts.map(p =>
    p.type === 'text' ? { ...p, text: expandedText } : p,
  );
  const replacedMsg: UIMessage = {
    ...last,
    parts: replacedParts as UIMessage['parts'],
  };

  return [...messages.slice(0, lastIdx), replacedMsg];
}
