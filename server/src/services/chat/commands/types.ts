// Types for the commands subsystem.

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
