// Reverse model→template index. Powers the "Used by" section in the model
// info modal so users can see at a glance which templates reference a given
// model file (basename match — folder-agnostic since templates reference by
// basename or `subfolder/basename`).
//
// Built lazily on first call, cached for 60 s, and explicitly invalidated
// when `saveUserWorkflow` writes a new template. Boot-time precompute isn't
// worth it — templates are read on demand from disk JSON either way, and the
// first modal open eats the build cost (~50–100 ms for a few hundred
// templates).

import fs from 'fs';
import { listAllNames } from '../../lib/db/templates.repo.js';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../../lib/fs.js';
import { extractDeps } from './depExtract.js';
import { normalizeModelFilename } from '../models/identity.js';
import { logger } from '../../lib/logger.js';

const CACHE_TTL_MS = 60_000;

interface Cache {
  builtAt: number;
  /** basename → set of template names referencing it. */
  index: Map<string, Set<string>>;
}

let cache: Cache | null = null;

function basenameOf(filename: string): string {
  const normalized = normalizeModelFilename(filename);
  return normalized.includes('/')
    ? (normalized.split('/').pop() ?? normalized)
    : normalized;
}

/** Read a user-workflow JSON file directly off disk. Inlined here (instead
 *  of importing `getUserWorkflowJson` from `./userTemplates`) so this
 *  module doesn't form an import cycle with userTemplates → which itself
 *  needs to call back into invalidateModelUsageIndex(). */
function readUserWorkflowJson(name: string): Record<string, unknown> | null {
  try {
    const abs = safeResolve(paths.userTemplatesDir, `${name}.json`);
    if (!fs.existsSync(abs)) return null;
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as { workflow?: unknown };
    if (!parsed.workflow || typeof parsed.workflow !== 'object') return null;
    return parsed.workflow as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildIndex(): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  let scanned = 0;
  let skipped = 0;
  for (const name of listAllNames()) {
    const workflow = readUserWorkflowJson(name);
    if (!workflow) { skipped++; continue; }
    let modelRefs: string[];
    try {
      modelRefs = extractDeps(workflow).models;
    } catch (err) {
      skipped++;
      logger.warn('modelUsageIndex: extractDeps failed', {
        name, error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const seenForTemplate = new Set<string>();
    for (const ref of modelRefs) {
      const basename = basenameOf(ref);
      if (!basename || seenForTemplate.has(basename)) continue;
      seenForTemplate.add(basename);
      let set = index.get(basename);
      if (!set) { set = new Set(); index.set(basename, set); }
      set.add(name);
    }
    scanned++;
  }
  logger.info('modelUsageIndex: built', {
    templates: scanned, skipped, distinctBasenames: index.size,
  });
  return index;
}

function getIndex(): Map<string, Set<string>> {
  const now = Date.now();
  if (cache && now - cache.builtAt < CACHE_TTL_MS) return cache.index;
  cache = { builtAt: now, index: buildIndex() };
  return cache.index;
}

/**
 * Templates whose workflow JSON references `filename` (matched by basename
 * after Windows-backslash normalization). Sorted, deduped.
 */
export function getUsedBy(filename: string): string[] {
  const basename = basenameOf(filename);
  if (!basename) return [];
  const set = getIndex().get(basename);
  return set ? Array.from(set).sort() : [];
}

/** Clear the cache. Call after any template upsert/delete so the next read
 *  rebuilds with current disk state. */
export function invalidateModelUsageIndex(): void {
  cache = null;
}
