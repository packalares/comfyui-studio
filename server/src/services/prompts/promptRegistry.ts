// Prompt-token registry loader.
//
// The PromptComposer in the UI recognises two flavours of chip token in a
// template string:
//
//   {a|[b]|c}    Inline options. Self-contained — registry doesn't matter.
//   @business    Named token. The list of options comes from this registry.
//
// Registry source: a JSON file at `paths.promptRegistryFile` mapping the
// token name (no `@`) to an array of option strings. File-missing is fine
// (returns `{}`); tokens with no registry entry are dropped at render time
// in the UI rather than surfaced as broken text.
//
// We cache the parsed file in memory and stat-poll on read so users can
// edit the JSON without restarting Studio. Tiny file (<1 KB typical) so
// reading on every request is also acceptable; the stat-check is just
// belt-and-suspenders.

import fs from 'node:fs';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';

export type PromptRegistry = Record<string, string[]>;

interface CacheEntry {
  mtimeMs: number;
  data: PromptRegistry;
}

let cache: CacheEntry | null = null;

/** Read the registry JSON from disk. Returns `{}` on missing file or any
 *  parse error (logged once per change so we don't spam during file edits). */
export function loadPromptRegistry(): PromptRegistry {
  const filePath = paths.promptRegistryFile;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cache = null;
    return {};
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.data;
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn?.(`[promptRegistry] failed to parse ${filePath}: ${(err as Error).message}`);
    cache = { mtimeMs: stat.mtimeMs, data: {} };
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn?.(`[promptRegistry] ${filePath} is not an object — ignoring`);
    cache = { mtimeMs: stat.mtimeMs, data: {} };
    return {};
  }
  const cleaned: PromptRegistry = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const opts = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (opts.length === 0) continue;
    cleaned[k] = opts;
  }
  cache = { mtimeMs: stat.mtimeMs, data: cleaned };
  return cleaned;
}
