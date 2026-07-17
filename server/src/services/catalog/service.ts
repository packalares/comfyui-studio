// Orchestrator: merge, refresh, upsert + scan adapter + event-bus subscribers.

import { getHfToken, getCivitaiToken, getGithubToken } from '../settings/index.js';
import { readSidecar } from '../models/enrichment/sidecar.js';
import { formatBytes } from '../../lib/format.js';
import { getHostAuthHeaders } from '../../lib/http.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import {
  load, persist, persistCurrent, seedFromComfyUI,
  markInstalled, markUninstalled, markDownloadFailed, findRow, findRowFromStore,
} from './store.js';
import { declaredByFor, mergeIntoExisting, urlSourceFor } from './urlSources.js';
import { canonicalizeSync } from './canonicalize.js';
import * as models from '../models/service.js';
import { invalidateModelListMemo } from '../models/info.js';
import { startHashQueue } from '../models/enrichment/hashCompute.js';
import type { CatalogModel, MergedModel, FileStatus, UrlSource } from '../../contracts/catalog.contract.js';

export type { CatalogModel, MergedModel, FileStatus };
export { seedFromComfyUI, markInstalled, markUninstalled, markDownloadFailed };

/** Size refresh cadence — re-HEAD entries this old on next access. */
const SIZE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getAllModels(): CatalogModel[] {
  return load().models;
}

/** Filename-only lookup used by the auto-resolver as a URL hint. Refuses to
 *  return ANYTHING when the filename is ambiguous (shared by multiple rows) —
 *  silently picking row[0] is how we ended up downloading the wrong repo's
 *  bytes earlier. Callers needing disambiguation should pass save_path via
 *  `findRowFromStore({filename, save_path})` directly. */
export function getModel(filename: string): CatalogModel | undefined {
  // Windows-authored workflows export widget values with backslash separators
  // (`flux1\ae.safetensors`). Catalog rows are stored canonical (forward
  // slash). Normalize on the way in so the lookup key matches.
  return findRowFromStore({ filename: filename.replace(/\\/g, '/') });
}

/** Strict (filename, save_path) lookup — symmetric with `upsertModel`'s
 *  storage key. The catalog canonicalizes both fields on write (subfolder
 *  prefix moves into save_path); callers that look up by the original
 *  workflow-declared path-prefixed name should canonicalize their args the
 *  same way before calling this. */
export function getModelByPair(
  filename: string, save_path: string,
): CatalogModel | undefined {
  return findRowFromStore({
    filename: filename.replace(/\\/g, '/'),
    save_path: save_path.replace(/\\/g, '/'),
  });
}

/** Merge or append a single entry. Existing entries keep their size + only missing fields are filled. */
export function upsertModel(
  entry: Omit<CatalogModel, 'size_pretty' | 'size_bytes' | 'size_fetched_at'>
    & Partial<Pick<CatalogModel, 'size_pretty' | 'size_bytes' | 'size_fetched_at'>>,
): CatalogModel {
  // Normalize the entry before dedup so `(save_path, filename)` keys match
  // across paths that wrote the same model with different shapes (e.g. a
  // pasted URL with `Wan/lora.safetensors` filename + save_path=loras vs a
  // template import with `lora.safetensors` filename + save_path=loras/Wan).
  const cleaned = canonicalizeSync(entry);
  if (cleaned.unrecoverable) {
    // Garbage in (Windows path, bare placeholder) — silently drop instead of
    // polluting the catalog. The original `entry` is lost; callers that
    // catalog from user input should validate upstream.
    return entry as CatalogModel;
  }
  entry = cleaned.entry as typeof entry;
  if (cleaned.pendingNodeInstall) {
    (entry as Partial<CatalogModel>).pendingNodeInstall = true;
  }
  const data = load();
  const existing = findRow(data.models, {
    filename: entry.filename,
    save_path: entry.save_path,
  });
  if (existing) {
    mergeIntoExisting(existing, entry);
    persist(data);
    return existing;
  }
  const fresh: CatalogModel = {
    size_pretty: entry.size_pretty ?? '',
    size_bytes: entry.size_bytes ?? 0,
    size_fetched_at: entry.size_fetched_at ?? null,
    ...entry,
  } as CatalogModel;
  // Synthesize urlSources[] from the legacy `url` field on first insert.
  // declaredBy mirrors the entry's source tag; absent that, falls back to 'seed'.
  if (fresh.url) {
    const src = urlSourceFor(fresh.url, declaredByFor(entry));
    if (src) fresh.urlSources = [src];
  }
  data.models.push(fresh);
  persist(data);
  return fresh;
}

export function isSizeStale(model: CatalogModel): boolean {
  if (!model.size_bytes || !model.size_fetched_at) return true;
  const age = Date.now() - Date.parse(model.size_fetched_at);
  return Number.isNaN(age) || age > SIZE_MAX_AGE_MS;
}

function detectGated(res: Response): string | null {
  const msg = res.headers.get('x-error-message');
  if (!msg) return null;
  if (/access.*restricted|must have access|be authenticated/i.test(msg)) return msg;
  return null;
}

// After the urlSources migration, walks the row's own urlSources[]; legacy
// rows fall back to a single-element list synthesized from model.url.
function refreshCandidates(model: CatalogModel): UrlSource[] {
  if (model.urlSources && model.urlSources.length > 0) return model.urlSources;
  const src = urlSourceFor(model.url, 'seed');
  return src ? [src] : [];
}

function applySizeHeaders(model: CatalogModel, res: Response): void {
  const linked = res.headers.get('x-linked-size');
  const contentLength = res.headers.get('content-length');
  const bytes = linked ? Number(linked) : contentLength ? Number(contentLength) : NaN;
  if (Number.isFinite(bytes) && bytes > 0) {
    model.size_bytes = bytes;
    model.size_pretty = formatBytes(bytes);
    model.size_fetched_at = new Date().toISOString();
  }
}

// HEAD the URL(s) to learn the real size. Mutates the catalog entry in place
// and persists. Marks gated on 401/403. Unknown failures leave state intact.
export async function refreshSize(
  filename: string,
  opts: { force?: boolean } = {},
): Promise<CatalogModel | null> {
  const model = getModel(filename);
  if (!model) return null;
  if (!opts.force && !isSizeStale(model) && !model.gated) return model;
  if (!model.url) return model;

  const tokens = {
    hfToken: getHfToken(),
    civitaiToken: getCivitaiToken(),
    githubToken: getGithubToken(),
  };
  for (const src of refreshCandidates(model)) {
    const url = src.url;
    const headers = getHostAuthHeaders(url, tokens);
    try {
      const res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' });
      if (res.status === 401 || res.status === 403) {
        model.gated = true;
        model.gated_message = detectGated(res) || 'This model requires authentication.';
        model.url = url;
        persistCurrent();
        return model;
      }
      if (!res.ok) continue;
      if (model.gated) {
        model.gated = undefined;
        model.gated_message = undefined;
      }
      applySizeHeaders(model, res);
      model.url = url;
      persistCurrent();
      return model;
    } catch {
      continue;
    }
  }
  return model;
}

// ---- Scan adapter (was catalog.scan.ts) ----

interface LauncherScanEntry {
  filename: string;
  name?: string;
  installed?: boolean;
  fileSize?: number;
  type?: string;
  save_path?: string;
  url?: string;
  base?: string;
  description?: string;
  reference?: string;
}

/** TTL for the scan result cache. Adjustable for tests via module replacement. */
export const SCAN_CACHE_TTL_MS = 30_000;

/** No-op kept for callers that still invalidate after install/uninstall events.
 *  The previous Manager-cache scan layer was removed from getMergedModels;
 *  there's no live scan cache to bust anymore. Catalog + on-disk model_files
 *  are read fresh on every getMergedModels call. */
export function bustScanCache(): void { /* no-op */ }

// ---- Merge ----

/** Merge catalog with disk scan for per-model install + integrity state.
 *
 *  Two sources only:
 *    1. catalog.json — the authoritative list of "models we know about"
 *       (template-driven, manual additions, plus the bundled / refreshed
 *       upstream model-list folded in at boot / rescan time).
 *    2. model_files (SQLite) — what is actually on disk right now.
 *
 *  We deliberately do NOT pull the Manager cache (`model-list.cache.json`)
 *  into this merge anymore. Earlier this function read both catalog AND
 *  Manager-cache via `fetchLauncherScan`, which double-listed every shared
 *  model under conflicting save_paths (e.g. `diffusion_models` from the
 *  user's catalog row vs `diffusion_models/Wan2.2` from upstream). The
 *  Manager cache now feeds the catalog via boot-seed + rescan upsert; once
 *  it lands as a catalog row, this merge can dedup cleanly against it.
 */
export async function getMergedModels(): Promise<MergedModel[]> {
  await seedFromComfyUI();

  const merged: MergedModel[] = [];
  const catalogFilenames = new Set<string>();

  for (const model of load().models) {
    if (model.filename) catalogFilenames.add(model.filename);
    // Match an on-disk file by (save_path, filename) first; fall back to
    // bare filename so legitimately-installed files at a different folder
    // than catalog records (e.g. user moved them) still register installed.
    const expectedRel = model.save_path ? `${model.save_path}/${model.filename}` : null;
    const candidates = modelFiles.listByFilename(model.filename);
    const exact = expectedRel
      ? candidates.find((r) => r.status === 'complete' && r.rel_path === expectedRel)
      : undefined;
    const any = candidates.find((r) => r.status === 'complete');
    const hit = exact ?? any;
    const installed = !!hit;
    const fileSize = hit?.size;

    const enrichment = installed ? readEnrichmentFor(model.filename) : undefined;
    merged.push({
      ...model,
      installed,
      fileSize,
      fileStatus: deriveFileStatus(model.size_bytes, fileSize, installed),
      ...(enrichment ? { enrichment } : {}),
    });
  }

  // Locally-discovered files — anything on disk whose filename does NOT
  // appear in the catalog. These are files the user dropped into the
  // ComfyUI models tree without going through Studio's install flow.
  for (const row of modelFiles.listAll()) {
    if (!row.filename || catalogFilenames.has(row.filename)) continue;
    if (row.status !== 'complete') continue;
    const dir = row.rel_path.includes('/')
      ? row.rel_path.slice(0, row.rel_path.lastIndexOf('/'))
      : '';
    const entry: MergedModel = {
      filename: row.filename,
      name: row.filename,
      type: 'other',
      save_path: dir,
      url: '',
      size_pretty: '',
      size_bytes: 0,
      size_fetched_at: null,
      source: 'scan',
      installed: true,
      fileSize: row.size,
      fileStatus: null,
    };
    const enrichment = readEnrichmentFor(entry.filename);
    if (enrichment) entry.enrichment = enrichment;
    merged.push(entry);
  }
  return merged;
}

function readEnrichmentFor(
  filename: string,
): import('../../contracts/catalog.contract.js').CatalogEnrichment {
  const absPath = modelFiles.listByFilename(filename)
    .find((r) => r.status === 'complete')?.abs_path;
  if (!absPath) return undefined;
  const sidecar = readSidecar(absPath);
  if (!sidecar) return undefined;
  return {
    tags: sidecar.tags,
    trigger_words: sidecar.trigger_words,
    nsfw_level: sidecar.nsfw_level,
    favorite: sidecar.favorite,
    metadata_source: sidecar.metadata_source,
    civitai_model_id: sidecar.civitai_model_id,
    civitai_version_id: sidecar.civitai_version_id,
    description: sidecar.description,
    preview_remote_url: sidecar.preview_remote_url,
    preview_local_path: sidecar.preview_local_path,
    base_model: sidecar.base_model,
    hf_repo: sidecar.hf_repo,
    urlSources_verified: sidecar.urlSources_verified,
  };
}

function scanEntryToMerged(s: LauncherScanEntry): MergedModel {
  return {
    filename: s.filename,
    name: s.name || s.filename,
    type: s.type || 'other',
    base: s.base,
    save_path: s.save_path || s.type || 'checkpoints',
    description: s.description,
    reference: s.reference,
    url: s.url || '',
    size_pretty: '',
    size_bytes: 0,
    size_fetched_at: null,
    source: 'scan',
    installed: !!s.installed,
    fileSize: s.fileSize,
    fileStatus: null,
  };
}

/** Exported for tests only — callers in this module use it directly. */
export function deriveFileStatus(expected: number, actual: number | undefined, installed: boolean): FileStatus {
  if (!installed) return null;
  if (!expected || !actual) return null;
  // 1 KB was too tight: some formats pad to filesystem block boundaries.
  // Allow up to 1% or 4 KB, whichever is larger.
  if (Math.abs(expected - actual) <= Math.max(4096, Math.floor(expected * 0.01))) return 'complete';
  return actual > expected ? 'corrupt' : 'incomplete';
}

/** Resolve many filenames in parallel with a small concurrency cap. */
export async function refreshMany(
  filenames: string[],
  opts: { force?: boolean; concurrency?: number } = {},
): Promise<void> {
  const cap = opts.concurrency ?? 8;
  const queue = filenames.slice();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < cap; i++) {
    workers.push((async () => {
      while (queue.length) {
        const fn = queue.shift();
        if (!fn) return;
        await refreshSize(fn, { force: opts.force });
      }
    })());
  }
  await Promise.all(workers);
}

// ---- Event-bus subscribers (was catalog.events.ts) ----

let wired = false;

// Call once at boot. Idempotent.
export function wireCatalogEventHandlers(): void {
  if (wired) return;
  wired = true;
  subscribeEvents();
}

/** Test-only: force re-subscription after bus.resetForTests(). */
export function rewireForTests(): void {
  wired = true;
  subscribeEvents();
}

function subscribeEvents(): void {
  bus.on('model:installed', ({ filename }) => {
    try {
      markInstalled(filename);
      bustScanCache();
      // Bug-A wire: info.ts holds its own memoised model list that
      // `deleteByName` reads via `getAllModels('cache')`. Without this
      // invalidation, a model that just finished downloading still shows
      // `installed: false` until the cache duration elapses, and any
      // delete against it 400s with "Model not installed".
      invalidateModelListMemo();
      // Kick the background sha256 queue so the freshly-installed row gets
      // its hash filled in. Idempotent — no-op when already running. The
      // queue walks every row whose sha256 is still null, so this also
      // back-fills any historical gaps the same pass.
      startHashQueue();
    } catch (err) {
      logger.warn('catalog model:installed hook failed', {
        filename, error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  bus.on('model:download-failed', ({ filename, error }) => {
    try {
      markDownloadFailed(filename, error);
    } catch (err) {
      logger.warn('catalog model:download-failed hook failed', {
        filename, error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  bus.on('model:removed', ({ filename }) => {
    // Keep the catalog entry (pure metadata + URL); flip installed→false so the
    // UI returns to "Not installed / Download" state immediately without waiting
    // for the next full scan.
    try {
      markUninstalled(filename);
      bustScanCache();
      invalidateModelListMemo();
    } catch (err) {
      logger.warn('catalog model:removed hook failed', {
        filename, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
