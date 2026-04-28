// Auto-resolution pass for staged import workflows (Wave L).
//
// For every model filename a workflow declares, try to find a downloadable
// URL using this chain (first hit wins):
//
//   1. Local catalog lookup by filename.
//   2. MarkdownNote URL whose basename matches the required filename — run
//      the HF / CivitAI resolver on it.
//   3. HuggingFace search, keep only results where exactly one repo has
//      exactly one file with the required filename.
//   4. CivitAI search, same exactly-one rule at the file level.
//   5. Unresolved — leave it alone.
//
// Steps 2-4 upsert the local catalog on success so the next import hits
// step 1 immediately. Steps 3 + 4 permanently skip per-basename when the
// public API rate-limits (429) so a follow-up filename doesn't retry.
//
// Per-workflow fan-out capped at 4 concurrent lookups to avoid hammering
// HF / CivitAI. Search caches are scoped to a single staging op via
// `newSearchCaches()` — don't reuse across stagings.

import * as catalog from '../catalog.js';
import { formatBytes } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import { env, autoResolveSearchEnabled } from '../../config/env.js';
import { resolveHuggingfaceUrl, type ResolvedModel } from '../models/resolveHuggingface.js';
import { resolveCivitaiUrl } from '../models/resolveCivitai.js';
import { folderForLoaderClass } from '../workflow/loaderFolders.js';
import { hfFindExactMatch, type HfSearchCache } from './autoResolve.hf.js';
import { civitaiFindExactMatch, type CivitaiSearchCache } from './autoResolve.civitai.js';
import type {
  AutoResolvedModel, AutoResolveSource,
  StagedImport, StagedWorkflowEntry,
} from './importStaging.js';

export type { AutoResolvedModel, AutoResolveSource };

const PER_WORKFLOW_CONCURRENCY = 4;

interface SearchCaches { hf: HfSearchCache; civitai: CivitaiSearchCache }
function newSearchCaches(): SearchCaches {
  return { hf: new Map(), civitai: new Map() };
}

function basenameOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').toLowerCase();
}
function sameFile(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

function urlBasename(raw: string): string | null {
  try {
    const u = new URL(raw);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/** Build the shared `AutoResolvedModel` envelope the UI consumes. */
function toAutoResolved(
  source: AutoResolveSource, resolved: ResolvedModel, loaderClass?: string,
): AutoResolvedModel {
  const out: AutoResolvedModel = {
    source, downloadUrl: resolved.downloadUrl, confidence: 'high',
  };
  // Loader-class wins over URL guess — see commitOverrides.ts for the
  // motivating bug. `LatentUpscaleModelLoader` files default to
  // `upscale_models` from filename heuristics; `LTXAVTextEncoderLoader`
  // files fall to the `checkpoints` ext fallback. Both wrong.
  const folder = folderForLoaderClass(loaderClass) || resolved.suggestedFolder;
  if (folder) out.suggestedFolder = folder;
  if (typeof resolved.sizeBytes === 'number') out.sizeBytes = resolved.sizeBytes;
  return out;
}

function upsertCatalogFromAuto(
  filename: string, resolved: ResolvedModel, loaderClass?: string,
): void {
  const folder = folderForLoaderClass(loaderClass)
    || resolved.suggestedFolder
    || 'checkpoints';
  const sizeBytes = typeof resolved.sizeBytes === 'number' ? resolved.sizeBytes : undefined;
  try {
    catalog.upsertModel({
      filename,
      name: filename,
      type: folder,
      save_path: folder,
      url: resolved.downloadUrl,
      size_bytes: sizeBytes,
      size_pretty: typeof sizeBytes === 'number' ? formatBytes(sizeBytes) : undefined,
      size_fetched_at: typeof sizeBytes === 'number' ? new Date().toISOString() : null,
      source: `auto-resolve:${resolved.source}`,
    });
  } catch (err) {
    // Non-fatal: auto-resolve must not break staging if the catalog write
    // fails (read-only FS, etc.). Log for ops visibility.
    logger.warn('autoResolveModels: catalog upsert failed', {
      filename, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Step 1 — catalog.

function stepCatalog(filename: string): AutoResolvedModel | null {
  const row = catalog.getModel(filename);
  if (!row || !row.url) return null;
  const out: AutoResolvedModel = {
    source: 'catalog', downloadUrl: row.url, confidence: 'high',
  };
  if (row.save_path) out.suggestedFolder = row.save_path;
  if (row.size_bytes && row.size_bytes > 0) out.sizeBytes = row.size_bytes;
  return out;
}

// Step 0 — workflow's own `properties.models[]` declaring a whole-HF-repo
// download via the `hfRepo` field. Used by custom-node models whose weights
// are a multi-file package (IndexTTS2 etc.). Producing an AutoResolvedModel
// entry here makes the staging + commit flow treat the row as "covered" so
// Import isn't blocked — and carries `hfRepo` + `suggestedFolder` through
// to the download step which shells out to `huggingface-cli download`.
function stepHfRepo(
  filename: string, workflow: Record<string, unknown>,
): AutoResolvedModel | null {
  const nodes = (workflow?.nodes as Array<Record<string, unknown>> | undefined) || [];
  // Also walk subgraph-internal nodes — the entry may live on a nested node.
  const inner: Array<Record<string, unknown>> = [];
  const defs = (workflow?.definitions as Record<string, unknown> | undefined)?.subgraphs;
  if (Array.isArray(defs)) {
    for (const sg of defs as Array<Record<string, unknown>>) {
      const sgNodes = (sg?.nodes as Array<Record<string, unknown>> | undefined) || [];
      inner.push(...sgNodes);
    }
  }
  for (const node of [...nodes, ...inner]) {
    const props = node.properties as Record<string, unknown> | undefined;
    const arr = (props?.models as Array<Record<string, unknown>> | undefined) || [];
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const name = raw.name as string | undefined;
      const hfRepo = raw.hfRepo as string | undefined;
      const dir = raw.directory as string | undefined;
      if (name === filename && hfRepo) {
        const out: AutoResolvedModel = {
          source: 'hfRepo',
          downloadUrl: '',
          hfRepo,
          confidence: 'high',
        };
        if (dir) out.suggestedFolder = dir;
        return out;
      }
    }
  }
  return null;
}

// Step 2 — MarkdownNote URL basename match.

async function stepMarkdown(
  filename: string, modelUrls: string[], loaderClass?: string,
): Promise<AutoResolvedModel | null> {
  for (const url of modelUrls) {
    const base = urlBasename(url);
    if (!base || !sameFile(base, filename)) continue;
    let resolved: ResolvedModel | null = null;
    try {
      const host = new URL(url).hostname;
      if (/huggingface\.co$/i.test(host)) resolved = await resolveHuggingfaceUrl(url);
      else if (/civitai\.com$/i.test(host)) resolved = await resolveCivitaiUrl(url);
    } catch { resolved = null; }
    if (!resolved || !sameFile(resolved.fileName, filename)) continue;
    upsertCatalogFromAuto(filename, resolved, loaderClass);
    return toAutoResolved('markdown', resolved, loaderClass);
  }
  return null;
}

// Step 3 — HuggingFace search (delegated to autoResolve.hf.ts).

async function stepHuggingface(
  filename: string, caches: SearchCaches, loaderClass?: string,
): Promise<AutoResolvedModel | null> {
  const resolved = await hfFindExactMatch(filename, basenameOf(filename), caches.hf);
  if (!resolved) return null;
  upsertCatalogFromAuto(filename, resolved, loaderClass);
  return toAutoResolved('huggingface', resolved, loaderClass);
}

// Step 4 — CivitAI search (delegated to autoResolve.civitai.ts).

async function stepCivitai(
  filename: string, caches: SearchCaches, loaderClass?: string,
): Promise<AutoResolvedModel | null> {
  const resolved = await civitaiFindExactMatch(filename, basenameOf(filename), caches.civitai);
  if (!resolved) return null;
  upsertCatalogFromAuto(filename, resolved, loaderClass);
  return toAutoResolved('civitai', resolved, loaderClass);
}

// ---------------------------------------------------------------------------
// Per-filename chain + per-workflow fan-out + staged-import entrypoint.

/**
 * Skip HF/CivitAI searches in test env unless the test opts back in via
 * `STUDIO_AUTO_RESOLVE_SEARCH=1`. Catalog + markdown-URL steps always run
 * (they're local and cheap). Keeps the wide blast-radius of imports-on-
 * test-env from stalling on DNS lookups to huggingface.co.
 */
function searchesEnabled(): boolean {
  if (env.NODE_ENV === 'test') return autoResolveSearchEnabled();
  return true;
}

async function resolveOne(
  filename: string, wf: StagedWorkflowEntry, caches: SearchCaches,
): Promise<AutoResolvedModel | null> {
  const loaderClass = wf.modelLoaderClasses?.[filename];
  // Whole-HF-repo declarations on a workflow's own `properties.models` win
  // over everything else — the author was explicit, no need to search.
  const s0 = stepHfRepo(filename, wf.workflow);
  if (s0) return s0;
  const s1 = stepCatalog(filename);
  if (s1) return s1;
  const s2 = await stepMarkdown(filename, wf.modelUrls || [], loaderClass);
  if (s2) return s2;
  if (!searchesEnabled()) return null;
  const s3 = await stepHuggingface(filename, caches, loaderClass);
  if (s3) return s3;
  const s4 = await stepCivitai(filename, caches, loaderClass);
  if (s4) return s4;
  return null;
}

/**
 * Resolve every filename in a single workflow, filling in
 * `wf.autoResolvedModels`. Runs with a fixed concurrency cap so a workflow
 * with many missing models doesn't fan out into dozens of parallel HF
 * calls. Mutates `wf` in place + returns the same reference.
 */
export async function autoResolveWorkflowModels(
  wf: StagedWorkflowEntry, caches?: SearchCaches,
): Promise<StagedWorkflowEntry> {
  const c = caches ?? newSearchCaches();
  const filenames = Array.from(new Set(wf.models || []));
  if (filenames.length === 0) {
    if (!wf.autoResolvedModels) wf.autoResolvedModels = {};
    return wf;
  }
  const out: Record<string, AutoResolvedModel> = { ...(wf.autoResolvedModels ?? {}) };
  const queue = filenames.slice();
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const fn = queue.shift();
      if (!fn) return;
      // User-paste resolutions win: skip the auto pass when already covered.
      if (wf.resolvedModels && fn in wf.resolvedModels) continue;
      try {
        const resolved = await resolveOne(fn, wf, c);
        if (resolved) out[fn] = resolved;
      } catch (err) {
        logger.warn('autoResolveModels: resolve failed', {
          filename: fn, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(PER_WORKFLOW_CONCURRENCY, filenames.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  wf.autoResolvedModels = out;
  return wf;
}

/** Run the auto-resolve pass across every staged workflow in one import. */
export async function autoResolveStagedImport(staged: StagedImport): Promise<StagedImport> {
  const caches = newSearchCaches();
  for (const wf of staged.workflows) {
    await autoResolveWorkflowModels(wf, caches);
  }
  return staged;
}
