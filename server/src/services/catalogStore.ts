// Persistent JSON store for the model catalog.
//
// Handles load/save and the lazy seed from ComfyUI's external model list.
// Everything stateful (cache, seed-in-flight promise) lives here so the
// higher-level `catalog.ts` surface can stay focused on merge / refresh logic.

import fs from 'fs';
import { env } from '../config/env.js';
import { paths } from '../config/paths.js';
import { atomicWrite } from '../lib/fs.js';
import { logger } from '../lib/logger.js';
import { urlSourceFor, declaredByFor } from './catalog.urlSources.js';
import { cascadeRead, refreshModelListCache } from './models/modelListCache.js';
import type { CatalogModel } from '../contracts/catalog.contract.js';

interface CatalogFile {
  version: 1;
  models: CatalogModel[];
  seeded_at?: string;
}

let cache: CatalogFile | null = null;
let seedInFlight: Promise<void> | null = null;
let watching = false;

/**
 * Watch the catalog file for direct edits so an admin who hand-tweaks
 * `catalog.json` doesn't need a server restart. Lazy-init on first `load()`
 * so test env-overrides of `paths.catalogFile` (set via `vi.mock`) take
 * effect before we wire the watcher. Disabled in NODE_ENV=test for
 * deterministic test runs.
 */
function ensureWatching(): void {
  if (watching) return;
  if (env.NODE_ENV === 'test') return;
  watching = true;
  try {
    fs.watchFile(paths.catalogFile, { interval: 2000 }, () => {
      cache = null;
    });
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

/**
 * One-shot lazy migration: synthesize `urlSources` from the legacy single
 * `url` for any row missing it. Idempotent — rows with `urlSources` are
 * left alone.
 */
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
  // paths.catalogFile is resolved live (a getter via env override) so tests
  // that swap the path between cases hit the right file. atomicWrite handles
  // dir creation (0o700) + temp-write + rename with file mode 0o600.
  atomicWrite(paths.catalogFile, JSON.stringify(data, null, 2));
}

export function persistCurrent(): void {
  persist(load());
}

/**
 * Mark a catalog row as complete-on-disk. Clears in-flight flag + any prior
 * error. Called from the completion path via `model:installed` event.
 */
export function markInstalled(filename: string, opts: { fileSize?: number } = {}): CatalogModel | null {
  const data = load();
  const m = data.models.find(x => x.filename === filename);
  if (!m) return null;
  m.downloading = false;
  m.error = undefined;
  if (opts.fileSize && (!m.size_bytes || m.size_bytes === 0)) {
    m.size_bytes = opts.fileSize;
  }
  persist(data);
  return m;
}

/**
 * Stamp a failure message on the catalog row and clear the in-flight flag.
 * Row stays around so the UI can offer a retry.
 */
export function markDownloadFailed(filename: string, error: string): CatalogModel | null {
  const data = load();
  const m = data.models.find(x => x.filename === filename);
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
    // Strip vanity subfolders from ComfyUI's external-model-list so template
    // widget_values that expect flat paths under the category keep matching.
    save_path: String(m.save_path || m.type || 'checkpoints').split('/')[0],
    description: m.description as string | undefined,
    reference: m.reference as string | undefined,
    url,
    size_pretty: '',
    size_bytes: 0,
    size_fetched_at: null,
    source: 'comfyui',
  };
  // Seed entries get their urlSources synthesized eagerly so reader code
  // never has to special-case a freshly-seeded row.
  if (url) {
    const src = urlSourceFor(url, 'seed');
    if (src) out.urlSources = [src];
  }
  return out;
}

/**
 * Seed catalog from the cascade (cache → bundled → empty). Idempotent.
 *
 * Refreshes the on-disk cache from upstream first when stale or absent so
 * a long-running pod periodically picks up new entries; cascade reads then
 * tolerate upstream outages (cache or bundled survives even when GitHub
 * is unreachable).
 */
export async function seedFromComfyUI(): Promise<void> {
  const data = load();
  if (data.models.length > 0) return;
  if (seedInFlight) return seedInFlight;
  seedInFlight = (async () => {
    try {
      await refreshModelListCache().catch(() => { /* offline-tolerant */ });
      const body = cascadeRead();
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
