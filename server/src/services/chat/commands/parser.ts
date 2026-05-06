// Slash-command parser: detect `/command args` in a message string.
// Only matches when the message starts with `/` (no leading whitespace).

export interface DetectedCommand {
  name: string;
  args: string;
}

/**
 * Detect a slash command at the start of `message`.
 * Returns `{ name, args }` when the message begins with `/word`,
 * or null when the message is not a slash command.
 *
 * Whitespace before the slash is intentionally NOT trimmed — the spec
 * says leading whitespace must reject (` /foo` is not a command).
 *
 * `args` is the text after the command name, with leading whitespace stripped.
 * When there is no text after the name, `args` is an empty string.
 */
export function detectSlashCommand(message: string): DetectedCommand | null {
  const match = message.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1]!;
  const args = (match[2] ?? '').trimStart();
  return { name, args };
}
