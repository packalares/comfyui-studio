// Shared types for the personality (souls + memory) subsystem.

export interface SoulFrontmatter {
  description?: string;
  [key: string]: unknown;
}

export interface ParsedSoul {
  name: string;
  /** Frontmatter fields parsed from the file header, or empty object. */
  frontmatter: Record<string, unknown>;
  /** The markdown body with frontmatter stripped. */
  body: string;
  /** Human-readable description: frontmatter `description` or first non-blank line. */
  description: string;
}
