// CivitAI search + exact-match lookup used by Wave L's auto-resolve pass.
//
// Mirrors `autoResolve.hf.ts` but queries
// `${env.CIVITAI_API_BASE}/models?query=<basename>`. The returned JSON
// nests `modelVersions[].files[]`; we flatten the tree to a list of
// "one file per row" search hits, then accept ONLY the rows whose
// `name` equals (case-insensitive) the required filename and where
// exactly one such row exists across the response. Anything more
// ambiguous is left unresolved.

import { env } from '../../config/env.js';
import { resolveCivitaiUrl } from '../models/resolveCivitai.js';
import type { ResolvedModel } from '../models/resolveHuggingface.js';

const SEARCH_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 4000;

function timedFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

interface CivitaiSearchModel {
  id?: number;
  type?: string;
  modelVersions?: Array<{
    id?: number;
    files?: Array<{
      name?: string;
      downloadUrl?: string;
      primary?: boolean;
      sizeKB?: number;
    }>;
  }>;
}

export interface CivitaiSearchFile {
  name: string;
  downloadUrl: string;
  modelId: number;
  versionId: number;
  modelType?: string;
  sizeBytes?: number;
}

export type CivitaiSearchCache = Map<string, CivitaiSearchFile[] | null>;

function sameFile(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (env.CIVITAI_TOKEN) h.Authorization = `Bearer ${env.CIVITAI_TOKEN}`;
  return h;
}

async function search(basename: string): Promise<CivitaiSearchFile[] | null> {
  const url = `${env.CIVITAI_API_BASE}/models?query=${encodeURIComponent(basename)}&limit=${SEARCH_LIMIT}`;
  try {
    const res = await timedFetch(url, authHeaders());
    if (res.status === 429) return null;
    if (!res.ok) return [];
    const body = await res.json() as { items?: CivitaiSearchModel[] } | unknown;
    if (!body || typeof body !== 'object') return [];
    const items = Array.isArray((body as { items?: unknown[] }).items)
      ? ((body as { items: CivitaiSearchModel[] }).items)
      : [];
    const out: CivitaiSearchFile[] = [];
    for (const model of items) {
      const modelId = typeof model.id === 'number' ? model.id : 0;
      if (!modelId) continue;
      const versions = Array.isArray(model.modelVersions) ? model.modelVersions : [];
      for (const v of versions) {
        const vid = typeof v.id === 'number' ? v.id : 0;
        const files = Array.isArray(v.files) ? v.files : [];
        for (const f of files) {
          const name = typeof f.name === 'string' ? f.name : '';
          const downloadUrl = typeof f.downloadUrl === 'string' ? f.downloadUrl : '';
          if (!name || !downloadUrl) continue;
          const entry: CivitaiSearchFile = { name, downloadUrl, modelId, versionId: vid };
          if (typeof model.type === 'string') entry.modelType = model.type;
          if (typeof f.sizeKB === 'number' && f.sizeKB > 0) {
            entry.sizeBytes = Math.round(f.sizeKB * 1024);
          }
          out.push(entry);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Return a `ResolvedModel` for the target filename, or null if 0/2+
 * matches, or if the upstream API is rate-limited. When the canonical
 * `resolveCivitaiUrl(modelPageUrl)` returns a different file than the
 * search hit (common when primary-flag ≠ the file we searched for), we
 * synthesize a minimal ResolvedModel directly from the search result.
 */
export async function civitaiFindExactMatch(
  filename: string, basename: string, cache: CivitaiSearchCache,
): Promise<ResolvedModel | null> {
  let files = cache.get(basename);
  if (files === undefined) {
    const res = await search(basename);
    cache.set(basename, res);
    files = res;
  }
  if (files === null || !files || files.length === 0) return null;

  const matches = files.filter((f) => sameFile(f.name, filename));
  if (matches.length !== 1) return null;
  const winner = matches[0];
  const pageUrl = `https://civitai.com/models/${winner.modelId}`;
  let resolved: ResolvedModel | null;
  try { resolved = await resolveCivitaiUrl(pageUrl); }
  catch { resolved = null; }
  if (resolved && sameFile(resolved.fileName, filename)) return resolved;
  // Canonical lookup didn't match — build a minimal resolution from the
  // search hit itself.
  const fake: ResolvedModel = {
    source: 'civitai',
    downloadUrl: winner.downloadUrl,
    fileName: winner.name,
    civitai: {
      modelId: winner.modelId,
      versionId: winner.versionId,
      modelType: winner.modelType,
    },
  };
  if (typeof winner.sizeBytes === 'number') fake.sizeBytes = winner.sizeBytes;
  return fake;
}
