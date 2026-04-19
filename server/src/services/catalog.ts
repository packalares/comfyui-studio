import fs from 'fs';
import path from 'path';
import os from 'os';
import { getHfToken } from './settings.js';

const CATALOG_FILE = process.env.STUDIO_CATALOG_FILE
  || path.join(os.homedir(), '.config', 'comfyui-studio', 'catalog.json');

const COMFYUI_URL = process.env.COMFYUI_URL || 'http://localhost:8188';

/** Size refresh cadence — re-HEAD entries this old on next access. */
const SIZE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Per-entry shape. Keyed globally by `filename`. */
export interface CatalogModel {
  filename: string;
  name: string;
  type: string;
  base?: string;
  save_path: string;
  description?: string;
  reference?: string;
  url: string;
  size_pretty: string;
  size_bytes: number;
  size_fetched_at: string | null;
  gated?: boolean;
  gated_message?: string;
  /** Where this entry was first discovered: 'comfyui' seed, 'template:<name>', or 'user'. */
  source: string;
}

interface CatalogFile {
  version: 1;
  models: CatalogModel[];
  seeded_at?: string;
}

let cache: CatalogFile | null = null;
let seedInFlight: Promise<void> | null = null;

function load(): CatalogFile {
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

function persist(data: CatalogFile): void {
  cache = data;
  const dir = path.dirname(CATALOG_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** Seed from ComfyUI's /api/externalmodel/getlist?mode=live on first run. Idempotent. */
export async function seedFromComfyUI(): Promise<void> {
  const data = load();
  if (data.models.length > 0) return; // already seeded
  if (seedInFlight) return seedInFlight;
  seedInFlight = (async () => {
    try {
      const res = await fetch(`${COMFYUI_URL}/api/externalmodel/getlist?mode=live`);
      if (!res.ok) return;
      const body = await res.json() as { models?: Array<Record<string, unknown>> };
      const src = body.models || [];
      const models: CatalogModel[] = src.map(m => ({
        filename: String(m.filename || ''),
        name: String(m.name || m.filename || ''),
        type: String(m.type || 'other'),
        base: m.base as string | undefined,
        // Strip vanity subfolders from ComfyUI's external-model-list (e.g. "diffusion_models/Wan2.1" → "diffusion_models").
        // Template widget_values expect files flat under the category; subfolders break literal-match at load time.
        // When a specific template needs a deeper path, its properties.models[].directory overwrites this later.
        save_path: String(m.save_path || m.type || 'checkpoints').split('/')[0],
        description: m.description as string | undefined,
        reference: m.reference as string | undefined,
        url: String(m.url || ''),
        // Intentionally zeroed — the stringy `size` from ComfyUI is stale; we HEAD on demand.
        size_pretty: '',
        size_bytes: 0,
        size_fetched_at: null,
        source: 'comfyui',
      })).filter(m => m.filename && m.url);
      persist({ version: 1, models, seeded_at: new Date().toISOString() });
    } catch {
      // leave empty; next call retries
    } finally {
      seedInFlight = null;
    }
  })();
  return seedInFlight;
}

export function getAllModels(): CatalogModel[] {
  return load().models;
}

export function getModel(filename: string): CatalogModel | undefined {
  return load().models.find(m => m.filename === filename);
}

/** Merge or append a single entry. If it exists, only fills in missing fields (never clobbers size info). */
export function upsertModel(entry: Omit<CatalogModel, 'size_pretty' | 'size_bytes' | 'size_fetched_at'> & Partial<Pick<CatalogModel, 'size_pretty' | 'size_bytes' | 'size_fetched_at'>>): CatalogModel {
  const data = load();
  const existing = data.models.find(m => m.filename === entry.filename);
  if (existing) {
    if (!existing.url && entry.url) existing.url = entry.url;
    if (!existing.name && entry.name) existing.name = entry.name;
    if (!existing.type && entry.type) existing.type = entry.type;
    // save_path: templates are authoritative for their workflow's expected path,
    // so let them overwrite the seed-time value. Non-template upserts (scan, catalog seed)
    // still respect the existing value.
    if (entry.save_path && (entry.source?.startsWith('template:') || !existing.save_path)) {
      existing.save_path = entry.save_path;
    }
    if (!existing.description && entry.description) existing.description = entry.description;
    if (!existing.reference && entry.reference) existing.reference = entry.reference;
    if (!existing.base && entry.base) existing.base = entry.base;
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

/** True when size info is missing or older than SIZE_MAX_AGE_MS. */
export function isSizeStale(model: CatalogModel): boolean {
  if (!model.size_bytes || !model.size_fetched_at) return true;
  const age = Date.now() - Date.parse(model.size_fetched_at);
  return Number.isNaN(age) || age > SIZE_MAX_AGE_MS;
}

/** Decode HuggingFace's "restricted access" message. Also works for 403. */
function detectGated(res: Response): string | null {
  const msg = res.headers.get('x-error-message');
  if (!msg) return null;
  if (/access.*restricted|must have access|be authenticated/i.test(msg)) return msg;
  return null;
}

/**
 * HEAD the URL to learn the real size (follows redirects, honors HF token).
 * Mutates the catalog entry in place and persists. Marks gated when auth required
 * and token is missing or insufficient. Network/unknown failures leave the entry unchanged.
 */
export async function refreshSize(filename: string, opts: { force?: boolean } = {}): Promise<CatalogModel | null> {
  const model = getModel(filename);
  if (!model) return null;
  if (!opts.force && !isSizeStale(model) && !model.gated) return model;
  if (!model.url) return model;

  const headers: Record<string, string> = {};
  const hfToken = getHfToken();
  if (hfToken && /huggingface\.co/.test(model.url)) {
    headers['Authorization'] = `Bearer ${hfToken}`;
  }

  try {
    const res = await fetch(model.url, { method: 'HEAD', headers, redirect: 'follow' });
    if (res.status === 401 || res.status === 403) {
      const gatedMsg = detectGated(res) || 'This model requires HuggingFace authentication.';
      model.gated = true;
      model.gated_message = gatedMsg;
      persistCurrent();
      return model;
    }
    // 401/403 cleared — reset gated flag if we had one.
    if (model.gated) {
      model.gated = undefined;
      model.gated_message = undefined;
    }
    // HF sometimes exposes the real file size via x-linked-size on redirect.
    const linked = res.headers.get('x-linked-size');
    const contentLength = res.headers.get('content-length');
    const bytes = linked ? Number(linked) : contentLength ? Number(contentLength) : NaN;
    if (res.ok && Number.isFinite(bytes) && bytes > 0) {
      model.size_bytes = bytes;
      model.size_pretty = formatBytes(bytes);
      model.size_fetched_at = new Date().toISOString();
    }
    persistCurrent();
    return model;
  } catch {
    // transient — leave state, caller can retry
    return model;
  }
}

function persistCurrent(): void {
  const data = load();
  persist(data);
}

/** Catalog entry augmented with on-disk state from the launcher scan. */
export interface MergedModel extends CatalogModel {
  installed: boolean;
  fileSize?: number;
  fileStatus?: 'complete' | 'incomplete' | 'corrupt' | null;
}

/** Merge the catalog with the launcher's current disk scan to compute per-model install + integrity state. */
export async function getMergedModels(): Promise<MergedModel[]> {
  await seedFromComfyUI();
  const launcherUrl = process.env.LAUNCHER_URL || 'http://localhost:3000';
  // Ask the launcher what's on disk. Each returned entry has filename + fileSize + installed flag.
  let scan: Array<{ filename: string; name?: string; installed?: boolean; fileSize?: number; type?: string; save_path?: string; url?: string; base?: string; description?: string; reference?: string }> = [];
  try {
    const res = await fetch(`${launcherUrl}/api/models`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) scan = data;
    }
  } catch { /* launcher down — treat as nothing on disk */ }

  // Index scan by filename for O(1) lookup and to detect scan-only entries (files on disk we never knew about).
  const scanByFilename = new Map<string, typeof scan[number]>();
  for (const s of scan) if (s.filename) scanByFilename.set(s.filename, s);

  const merged: MergedModel[] = [];
  const seenFilenames = new Set<string>();

  for (const model of load().models) {
    seenFilenames.add(model.filename);
    const disk = scanByFilename.get(model.filename);
    const installed = !!disk?.installed;
    const fileSize = disk?.fileSize;
    merged.push({ ...model, installed, fileSize, fileStatus: deriveFileStatus(model.size_bytes, fileSize, installed) });
  }

  // Files on disk that aren't in our catalog — append them so Models page still shows them,
  // sourced as `scan` with no URL (manually-placed models or legacy).
  for (const s of scan) {
    if (!s.filename || seenFilenames.has(s.filename)) continue;
    merged.push({
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
      fileStatus: null, // no expected size to compare against
    });
  }

  return merged;
}

function deriveFileStatus(expected: number, actual: number | undefined, installed: boolean): MergedModel['fileStatus'] {
  if (!installed) return null;
  if (!expected || !actual) return null; // need both sides to decide
  if (Math.abs(expected - actual) < 1024) return 'complete';
  return actual > expected ? 'corrupt' : 'incomplete';
}

/** Resolve many filenames in parallel with a small concurrency cap. */
export async function refreshMany(filenames: string[], opts: { force?: boolean; concurrency?: number } = {}): Promise<void> {
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
