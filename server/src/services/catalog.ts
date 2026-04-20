// Model catalog: merge, refresh, upsert.
//
// The on-disk JSON store and seed logic live in `catalogStore.ts`; this file
// keeps the higher-level surface (refresh, merge with launcher scan) focused
// and re-exports the persistent-store helpers so existing call sites keep
// working without changes.

import { getHfToken } from './settings.js';
import { paths } from '../config/paths.js';
import { formatBytes } from '../lib/format.js';
import { getHfAuthHeaders } from '../lib/http.js';
import { statModelOnDisk } from '../lib/fs.js';
import { load, persist, persistCurrent, seedFromComfyUI } from './catalogStore.js';
import { fetchLauncherScan, type LauncherScanEntry } from './catalog.scan.js';
import type { CatalogModel, MergedModel, FileStatus } from '../contracts/catalog.contract.js';

export type { CatalogModel, MergedModel, FileStatus };
export { seedFromComfyUI };

/** Size refresh cadence — re-HEAD entries this old on next access. */
const SIZE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getAllModels(): CatalogModel[] {
  return load().models;
}

export function getModel(filename: string): CatalogModel | undefined {
  return load().models.find(m => m.filename === filename);
}

/** Merge or append a single entry. Existing entries keep their size + missing-fields-only are filled. */
export function upsertModel(
  entry: Omit<CatalogModel, 'size_pretty' | 'size_bytes' | 'size_fetched_at'>
    & Partial<Pick<CatalogModel, 'size_pretty' | 'size_bytes' | 'size_fetched_at'>>,
): CatalogModel {
  const data = load();
  const existing = data.models.find(m => m.filename === entry.filename);
  if (existing) {
    mergeMissingInto(existing, entry);
    persist(data);
    return existing;
  }
  const fresh: CatalogModel = {
    size_pretty: entry.size_pretty ?? '',
    size_bytes: entry.size_bytes ?? 0,
    size_fetched_at: entry.size_fetched_at ?? null,
    ...entry,
  } as CatalogModel;
  data.models.push(fresh);
  persist(data);
  return fresh;
}

function mergeMissingInto(existing: CatalogModel, entry: Partial<CatalogModel>): void {
  if (!existing.url && entry.url) existing.url = entry.url;
  if (!existing.name && entry.name) existing.name = entry.name;
  if (!existing.type && entry.type) existing.type = entry.type;
  // save_path: templates are authoritative for their workflow's expected path,
  // so let them overwrite the seed-time value. Non-template upserts still respect existing.
  if (entry.save_path && (entry.source?.startsWith('template:') || !existing.save_path)) {
    existing.save_path = entry.save_path;
  }
  if (!existing.description && entry.description) existing.description = entry.description;
  if (!existing.reference && entry.reference) existing.reference = entry.reference;
  if (!existing.base && entry.base) existing.base = entry.base;
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

function collectMirrors(model: CatalogModel): string[] {
  const out = [model.url];
  for (const m of load().models) {
    if (m.filename === model.filename && m.url && !out.includes(m.url)) out.push(m.url);
  }
  return out;
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

/**
 * HEAD the URL(s) to learn the real size. Mutates the catalog entry in place
 * and persists. Marks gated on 401/403. Unknown failures leave state intact.
 */
export async function refreshSize(
  filename: string,
  opts: { force?: boolean } = {},
): Promise<CatalogModel | null> {
  const model = getModel(filename);
  if (!model) return null;
  if (!opts.force && !isSizeStale(model) && !model.gated) return model;
  if (!model.url) return model;

  for (const url of collectMirrors(model)) {
    const headers = getHfAuthHeaders(url, getHfToken());
    try {
      const res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' });
      if (res.status === 401 || res.status === 403) {
        model.gated = true;
        model.gated_message = detectGated(res) || 'This model requires HuggingFace authentication.';
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

/** Merge catalog with launcher's disk scan for per-model install + integrity state. */
export async function getMergedModels(): Promise<MergedModel[]> {
  await seedFromComfyUI();
  const scan = await fetchLauncherScan();
  const scanByFilename = new Map<string, typeof scan[number]>();
  for (const s of scan) if (s.filename) scanByFilename.set(s.filename, s);

  const merged: MergedModel[] = [];
  const seenFilenames = new Set<string>();
  const modelsDir = paths.modelsDir;

  for (const model of load().models) {
    seenFilenames.add(model.filename);
    const disk = scanByFilename.get(model.filename);
    let installed = !!disk?.installed;
    let fileSize = disk?.fileSize;
    if (!installed) {
      const diskSize = statModelOnDisk(modelsDir, model.save_path, model.filename);
      if (diskSize !== null) { installed = true; fileSize = diskSize; }
    }
    merged.push({
      ...model,
      installed,
      fileSize,
      fileStatus: deriveFileStatus(model.size_bytes, fileSize, installed),
    });
  }

  for (const s of scan) {
    if (!s.filename || seenFilenames.has(s.filename)) continue;
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
