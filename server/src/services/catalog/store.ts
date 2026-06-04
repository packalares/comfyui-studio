// Persistent JSON store for the model catalog (load/save + lazy seed).

import fs from 'fs';
import { env } from '../../config/env.js';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import { urlSourceFor, declaredByFor } from './urlSources.js';
import {
  ensureModelListCacheSeeded, getCachedModelList,
} from '../models/info.js';
import type { CatalogModel } from '../../contracts/catalog.contract.js';

export interface CatalogFile {
  version: number;
  models: CatalogModel[];
  seeded_at?: string;
}

let cache: CatalogFile | null = null;
let seedInFlight: Promise<void> | null = null;
let watching = false;

// Disabled in test to keep runs deterministic; lazy-init so `vi.mock` path
// overrides take effect before the watcher fires.
function ensureWatching(): void {
  if (watching) return;
  if (env.NODE_ENV === 'test') return;
  watching = true;
  try {
    fs.watchFile(paths.catalogFile, { interval: 2000 }, () => { cache = null; });
  } catch (err) {
    logger.warn('catalog watchFile failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function load(): CatalogFile {
  if (cache) return cache;
  try {
    if (fs.existsSync(paths.catalogFile)) {
      const raw = fs.readFileSync(paths.catalogFile, 'utf8');
      const parsed = JSON.parse(raw) as CatalogFile;
      cache = migrateForUrlSources(parsed);
    } else {
      cache = { version: 1, models: [] };
    }
  } catch {
    cache = { version: 1, models: [] };
  }
  ensureWatching();
  return cache;
}

// One-shot lazy migration: synthesize urlSources from legacy single-url rows.
function migrateForUrlSources(file: CatalogFile): CatalogFile {
  for (const m of file.models) {
    if (m.urlSources && m.urlSources.length > 0) continue;
    if (!m.url) continue;
    const src = urlSourceFor(m.url, declaredByFor(m));
    if (src) m.urlSources = [src];
  }
  return file;
}

export function persist(data: CatalogFile): void {
  cache = data;
  // paths.catalogFile is a live getter so test path-overrides hit the right file.
  // atomicWrite handles dir creation + temp-write + rename with mode 0o600.
  atomicWrite(paths.catalogFile, JSON.stringify(data, null, 2));
}

export function persistCurrent(): void {
  persist(load());
}

/**
 * Canonical row lookup. The catalog row's IDENTITY is its disk location, not
 * its bare basename — multi-file HF models like ACE-Step transcriber/captioner
 * both ship `model-00001-of-00005.safetensors`. ALL row-finding logic should
 * delegate here so the (save_path, filename) key is enforced consistently.
 *
 * Resolution order:
 *   1. Exact (filename, save_path) match — strictest, used by upsertModel / merge.
 *   2. Name match — bus events emit `displayName` as their `filename` field for
 *      multi-file HF repo downloads (download.ts:208).
 *   3. Filename-only, but ONLY when unambiguous. Returns undefined when 2+ rows
 *      share the filename — caller must disambiguate by providing save_path
 *      rather than risk auto-selecting the wrong row.
 */
/**
 * Pure lookup over a passed-in row array. Operates on whatever snapshot the
 * caller already has so mutations + persist stay coherent. Callers needing a
 * fresh read use `findRowFromStore` (below).
 */
export function findRow(
  models: CatalogModel[],
  query: { filename?: string; save_path?: string; name?: string },
): CatalogModel | undefined {
  if (query.filename && query.save_path) {
    const hit = models.find(m =>
      m.filename === query.filename && (m.save_path || '') === query.save_path);
    if (hit) return hit;
  }
  if (query.name) {
    const hit = models.find(m => m.name === query.name);
    if (hit) return hit;
  }
  if (query.filename) {
    const matches = models.filter(m => m.filename === query.filename);
    if (matches.length === 1) return matches[0];
    // 0 or 2+ matches → undefined. Ambiguous filename-only lookups silently
    // picking row[0] is the root of half of today's bugs — refuse.
  }
  return undefined;
}

/** findRow that loads a fresh snapshot. Read-only — callers that mutate must
 *  use findRow + persist(data) together to stay coherent. */
export function findRowFromStore(query: Parameters<typeof findRow>[1]): CatalogModel | undefined {
  return findRow(load().models, query);
}

// Clears the in-flight flag + any prior error. Called via model:installed event.
// Event carries `filename`, which may be either the on-disk filename OR the
// display name for HF-repo downloads. findRow handles both via name-fallback.
export function markInstalled(filename: string, opts: { fileSize?: number; save_path?: string } = {}): CatalogModel | null {
  const data = load();
  const m = findRow(data.models, { filename, save_path: opts.save_path, name: filename });
  if (!m) return null;
  m.downloading = false;
  m.error = undefined;
  if (opts.fileSize && (!m.size_bytes || m.size_bytes === 0)) {
    m.size_bytes = opts.fileSize;
  }
  persist(data);
  return m;
}

// Stamps a failure message on the row and clears the in-flight flag; row stays for retry.
export function markDownloadFailed(filename: string, error: string, save_path?: string): CatalogModel | null {
  const data = load();
  const m = findRow(data.models, { filename, save_path, name: filename });
  if (!m) return null;
  m.downloading = false;
  m.error = error;
  persist(data);
  return m;
}

function mapSeedEntry(m: Record<string, unknown>): CatalogModel {
  const url = String(m.url || '');
  const out: CatalogModel = {
    filename: String(m.filename || ''),
    name: String(m.name || m.filename || ''),
    type: String(m.type || 'other'),
    base: m.base as string | undefined,
    // Strip vanity subfolders so template widget_values that expect flat paths keep matching.
    save_path: String(m.save_path || m.type || 'checkpoints').split('/')[0],
    description: m.description as string | undefined,
    reference: m.reference as string | undefined,
    url,
    size_pretty: '',
    size_bytes: 0,
    size_fetched_at: null,
    source: 'comfyui',
  };
  // Seed entries get urlSources synthesized eagerly so reader code never special-cases fresh rows.
  if (url) {
    const src = urlSourceFor(url, 'seed');
    if (src) out.urlSources = [src];
  }
  return out;
}

// Seed catalog from on-disk model-list cache. Idempotent.
// On first boot the cache is copied from the bundled seed; upstream refresh
// only happens via the explicit /api/models/rescan endpoint.
export async function seedFromComfyUI(): Promise<void> {
  const data = load();
  if (data.models.length > 0) return;
  if (seedInFlight) return seedInFlight;
  seedInFlight = (async () => {
    try {
      await ensureModelListCacheSeeded();
      const body = getCachedModelList();
      const models = (body.models || [])
        .map(mapSeedEntry)
        .filter(m => m.filename && m.url);
      if (models.length > 0) {
        persist({ version: 1, models, seeded_at: new Date().toISOString() });
      }
    } catch {
      // leave empty; next call retries
    } finally {
      seedInFlight = null;
    }
  })();
  return seedInFlight;
}
