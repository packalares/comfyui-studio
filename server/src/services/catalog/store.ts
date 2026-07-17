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
import { identityEquals } from '../models/identity.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
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
    const queryId = { filename: query.filename, save_path: query.save_path };
    // Strict (save_path, filename) match first via identityEquals.
    const strict = models.find(m => identityEquals(
      { filename: m.filename, save_path: m.save_path || '' },
      queryId,
    ));
    if (strict) return strict;
    // Case-insensitive secondary fallback (audit C5): catches Windows-authored
    // filenames whose casing differs from the on-disk canonical form.
    const ci = models.find(m => identityEquals(
      { filename: m.filename, save_path: m.save_path || '' },
      queryId,
      { caseInsensitive: true },
    ));
    if (ci) return ci;
  }
  if (query.name) {
    const hit = models.find(m => m.name === query.name);
    if (hit) return hit;
  }
  if (query.filename) {
    // Strict filename-only first, then case-insensitive fallback.
    const strictMatches = models.filter(m => m.filename === query.filename);
    if (strictMatches.length === 1) return strictMatches[0];
    if (strictMatches.length === 0) {
      const ciMatches = models.filter(
        m => m.filename.toLowerCase() === query.filename!.toLowerCase(),
      );
      if (ciMatches.length === 1) return ciMatches[0];
    }
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

// Clears in-flight flags when the file is deleted from disk. Keeps the catalog
// row (pure metadata + URL) so the user can re-download easily. The `installed`
// and `fileSize` fields live on MergedModel and are re-derived from the disk
// scan on the next getMergedModels call; persisting them is not needed here.
export function markUninstalled(filename: string, save_path?: string): CatalogModel | null {
  const data = load();
  const m = findRow(data.models, { filename, save_path, name: filename });
  if (!m) return null;
  m.downloading = false;
  m.error = undefined;
  // Clear the on-disk size so the next getMergedModels reports null fileStatus
  // rather than "incomplete/corrupt" for a file that no longer exists.
  m.size_bytes = 0;
  m.size_pretty = '';
  m.size_fetched_at = null;
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
    // Preserve subfolders (e.g. "diffusion_models/Wan2.2"). The
    // `canonicalizeSync` gate (run on every upsertModel) validates the
    // value against the type's registered folder list and trims invalid
    // shapes; we no longer pre-flatten here.
    save_path: String(m.save_path || m.type || 'checkpoints'),
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

/**
 * Merge an upstream model-list payload into the catalog by URL identity.
 *
 * Strategy:
 *  - For each upstream entry: look up an existing catalog row whose `url`
 *    matches (exact string equality). URL is the source of truth for "same
 *    model" — Kijai and Comfy-Org may publish the SAME filename at different
 *    URLs (different files); they must stay as separate catalog rows.
 *  - When a matching row IS found AND it is NOT yet installed, refresh its
 *    metadata from upstream — name, type, save_path, description, etc. —
 *    so users get newer subfolder conventions / better names on rescan.
 *    Installed rows are left alone: the file is on disk at its current
 *    save_path, and moving the catalog row away from that location would
 *    break dedup against the disk scan.
 *  - When NO catalog row matches the upstream URL, insert a new row from
 *    the upstream metadata.
 *
 * All writes go through `upsertModel` so `canonicalizeSync` runs — invalid
 * save_paths (e.g. `unet_gguf` for a `diffusion_model`) are validated and
 * downgraded to the canonical folder for the type before persisting.
 *
 * Returns counts so the caller can log a summary.
 */
export function mergeUpstreamIntoCatalog(
  upstreamModels: ReadonlyArray<Record<string, unknown>>,
  upsertModelFn: (entry: CatalogModel) => CatalogModel,
): { added: number; updated: number; skipped: number } {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  const data = load();
  // Index existing catalog rows by URL for O(1) lookup. Multiple rows may
  // share a URL (rare — usually template-import races); we honour the first
  // match for stability.
  const byUrl = new Map<string, CatalogModel>();
  for (const m of data.models) {
    if (m.url && !byUrl.has(m.url)) byUrl.set(m.url, m);
  }

  for (const raw of upstreamModels) {
    const url = String(raw.url || '');
    if (!url || !raw.filename) { skipped++; continue; }

    const existing = byUrl.get(url);
    if (existing) {
      // Installed rows are off-limits — the file is at its current save_path,
      // don't drift the catalog away from disk reality. `installed` is a
      // computed merge-time field, not stored on the catalog row, so probe
      // the on-disk model_files index directly. Considered installed when
      // ANY file with this filename has status=complete on disk.
      if (existing.filename) {
        const onDisk = modelFiles
          .listByFilename(existing.filename)
          .some((r) => r.status === 'complete');
        if (onDisk) { skipped++; continue; }
      }
      // Update non-identity fields. Identity (filename + url) stays put.
      const merged: CatalogModel = {
        ...existing,
        name: (raw.name as string | undefined) ?? existing.name,
        type: (raw.type as string | undefined) ?? existing.type,
        base: (raw.base as string | undefined) ?? existing.base,
        save_path: (raw.save_path as string | undefined) ?? existing.save_path,
        description: (raw.description as string | undefined) ?? existing.description,
        reference: (raw.reference as string | undefined) ?? existing.reference,
      };
      // Detect a real diff so we don't churn writes on every refresh.
      const before = JSON.stringify({
        name: existing.name, type: existing.type, base: existing.base,
        save_path: existing.save_path, description: existing.description,
        reference: existing.reference,
      });
      const after = JSON.stringify({
        name: merged.name, type: merged.type, base: merged.base,
        save_path: merged.save_path, description: merged.description,
        reference: merged.reference,
      });
      if (before !== after) {
        upsertModelFn(merged);
        updated++;
      } else {
        skipped++;
      }
    } else {
      // New entry — synth a catalog row from the upstream metadata.
      // `canonicalizeSync` (via upsertModel) validates save_path.
      const seed = mapSeedEntry(raw);
      upsertModelFn(seed);
      added++;
    }
  }

  return { added, updated, skipped };
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
