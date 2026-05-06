// Parse a markdown file's YAML-ish frontmatter block.
// Pure function — no I/O, no side effects.

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Split a raw markdown string into frontmatter fields and body.
 * Frontmatter is a `--- ... ---` block at the start of the file.
 * Values containing commas are kept as-is (no YAML arrays — this is
 * a simple key: value parser, not a full YAML parser).
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: raw };
  }

  const frontmatter: Record<string, unknown> = {};
  const fmLines = (fmMatch[1] ?? '').split('\n');

  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    // Detect YAML list items under the key by looking for subsequent
    // `  - item` lines — handled by aggregating into the same key as array.
    // For simplicity, only top-level scalar values are supported here.
    frontmatter[key] = val;
  }

  // Handle simple YAML list values: `scripts:\n  - a.py\n  - b.py`
  // Re-parse as list when value is empty and next lines are `  - ...`
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i]!;
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      if (key && val === '') {
        // Collect subsequent `  - item` lines
        const items: string[] = [];
        let j = i + 1;
        while (j < fmLines.length && /^\s+-\s+/.test(fmLines[j]!)) {
          items.push(fmLines[j]!.replace(/^\s+-\s+/, '').trim());
          j++;
        }
        if (items.length > 0) {
          frontmatter[key] = items;
          i = j;
          continue;
        }
      }
    }
    i++;
  }

  return { frontmatter, body: (fmMatch[2] ?? '').trimStart() };
}
