// Persistent JSON store for the model catalog.
//
// Handles load/save and the lazy seed from ComfyUI's external model list.
// Everything stateful (cache, seed-in-flight promise) lives here so the
// higher-level `catalog.ts` surface can stay focused on merge / refresh logic.

import fs from 'fs';
import { paths } from '../config/paths.js';
import { atomicWrite } from '../lib/fs.js';
import type { CatalogModel } from '../contracts/catalog.contract.js';

const CATALOG_FILE = paths.catalogFile;

interface CatalogFile {
  version: 1;
  models: CatalogModel[];
  seeded_at?: string;
}

let cache: CatalogFile | null = null;
let seedInFlight: Promise<void> | null = null;

export function load(): CatalogFile {
  if (cache) return cache;
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      const raw = fs.readFileSync(CATALOG_FILE, 'utf8');
      cache = JSON.parse(raw) as CatalogFile;
    } else {
      cache = { version: 1, models: [] };
    }
  } catch {
    cache = { version: 1, models: [] };
  }
  return cache;
}

export function persist(data: CatalogFile): void {
  cache = data;
  // CATALOG_FILE is a path resolved from env/paths at module load; atomicWrite
  // handles dir creation (0o700) + temp-write + rename with file mode 0o600.
  atomicWrite(CATALOG_FILE, JSON.stringify(data, null, 2));
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
  return {
    filename: String(m.filename || ''),
    name: String(m.name || m.filename || ''),
    type: String(m.type || 'other'),
    base: m.base as string | undefined,
    // Strip vanity subfolders from ComfyUI's external-model-list so template
    // widget_values that expect flat paths under the category keep matching.
    save_path: String(m.save_path || m.type || 'checkpoints').split('/')[0],
    description: m.description as string | undefined,
    reference: m.reference as string | undefined,
    url: String(m.url || ''),
    size_pretty: '',
    size_bytes: 0,
    size_fetched_at: null,
    source: 'comfyui',
  };
}

/**
 * Seed catalog from the canonical upstream on first run. Idempotent.
 * Pulls directly from ltdrdata/ComfyUI-Manager's GitHub-hosted
 * `model-list.json` so seeding works even when ComfyUI isn't running
 * (and doesn't require ComfyUI-Manager to be installed inside ComfyUI).
 */
const MODEL_LIST_URL =
  'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json';

export async function seedFromComfyUI(): Promise<void> {
  const data = load();
  if (data.models.length > 0) return;
  if (seedInFlight) return seedInFlight;
  seedInFlight = (async () => {
    try {
      const res = await fetch(MODEL_LIST_URL);
      if (!res.ok) return;
      const body = await res.json() as { models?: Array<Record<string, unknown>> };
      const models = (body.models || [])
        .map(mapSeedEntry)
        .filter(m => m.filename && m.url);
      persist({ version: 1, models, seeded_at: new Date().toISOString() });
    } catch {
      // leave empty; next call retries
    } finally {
      seedInFlight = null;
    }
  })();
  return seedInFlight;
}
