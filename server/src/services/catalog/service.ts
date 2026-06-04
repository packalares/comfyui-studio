// Orchestrator: merge, refresh, upsert + scan adapter + event-bus subscribers.

import { getHfToken, getCivitaiToken, getGithubToken } from '../settings/index.js';
import { formatBytes } from '../../lib/format.js';
import { getHostAuthHeaders } from '../../lib/http.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import {
  load, persist, persistCurrent, seedFromComfyUI,
  markInstalled, markDownloadFailed, findRow, findRowFromStore,
} from './store.js';
import { declaredByFor, mergeIntoExisting, urlSourceFor } from './urlSources.js';
import { canonicalizeSync } from './canonicalize.js';
import * as models from '../models/service.js';
import type { CatalogModel, MergedModel, FileStatus, UrlSource } from '../../contracts/catalog.contract.js';

export type { CatalogModel, MergedModel, FileStatus };
export { seedFromComfyUI, markInstalled, markDownloadFailed };

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
  return findRowFromStore({ filename });
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

async function fetchLauncherScan(): Promise<LauncherScanEntry[]> {
  try {
    const list = await models.scanAndRefresh();
    const out: LauncherScanEntry[] = [];
    for (const m of list) {
      const wire = models.toWireEntry(m);
      if (!wire.filename) continue;
      out.push({
        filename: wire.filename,
        name: wire.name,
        installed: wire.installed,
        fileSize: wire.fileSize,
        type: wire.type,
        save_path: wire.save_path,
        url: wire.url,
        base: wire.base,
        description: wire.description,
        reference: wire.reference,
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---- Merge ----

/** Merge catalog with launcher's disk scan for per-model install + integrity state. */
export async function getMergedModels(): Promise<MergedModel[]> {
  await seedFromComfyUI();
  const scan = await fetchLauncherScan();
  // Key by (save_path, filename) — bare filename collides when the same
  // shard name appears in multiple folders (e.g. ACE-Step transcriber and
  // captioner both ship model-00001-of-00005.safetensors).
  const scanByKey = new Map<string, typeof scan[number]>();
  for (const s of scan) {
    if (!s.filename) continue;
    const key = s.save_path ? `${s.save_path}/${s.filename}` : s.filename;
    scanByKey.set(key, s);
  }

  const merged: MergedModel[] = [];
  const seenKeys = new Set<string>();

  for (const model of load().models) {
    const key = model.save_path ? `${model.save_path}/${model.filename}` : model.filename;
    seenKeys.add(key);
    const disk = scanByKey.get(key);
    let installed = !!disk?.installed;
    let fileSize = disk?.fileSize;
    if (!installed) {
      const expected = model.save_path ? `${model.save_path}/${model.filename}` : null;
      const hit = modelFiles.listByFilename(model.filename)
        .find((r) => r.status === 'complete' && (!expected || r.rel_path === expected));
      if (hit) { installed = true; fileSize = hit.size; }
    }
    merged.push({
      ...model,
      installed,
      fileSize,
      fileStatus: deriveFileStatus(model.size_bytes, fileSize, installed),
    });
  }

  for (const s of scan) {
    if (!s.filename) continue;
    const key = s.save_path ? `${s.save_path}/${s.filename}` : s.filename;
    if (seenKeys.has(key)) continue;
    merged.push(scanEntryToMerged(s));
  }
  return merged;
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

function deriveFileStatus(expected: number, actual: number | undefined, installed: boolean): FileStatus {
  if (!installed) return null;
  if (!expected || !actual) return null;
  if (Math.abs(expected - actual) < 1024) return 'complete';
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
    // Keep the catalog entry (it's pure metadata); clear in-flight flag so
    // the UI returns to a clean "Not installed / Download" state.
    try {
      markInstalled(filename); // no fileSize -> clears downloading + error, leaves size_bytes
    } catch (err) {
      logger.warn('catalog model:removed hook failed', {
        filename, error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
