// HuggingFace search + tree walker used by Wave L's auto-resolve pass.
//
// Exposes a single function — `hfFindExactMatch(filename)` — that queries
// `GET /api/models?search=<basename>` for the filename's basename, walks
// up to MAX_REPOS_PER_SEARCH candidate repos, and returns a resolved
// download URL ONLY when exactly one repo contains exactly one file whose
// name matches the required filename. Ambiguous hits (0 or 2+) return
// null. 429 responses propagate null + set the cache entry to null so the
// caller permanently skips retrying within this staging op.

import { env } from '../../config/env.js';
import { resolveHuggingfaceUrl, type ResolvedModel } from '../models/resolveHuggingface.js';

const MAX_REPOS_PER_SEARCH = 3;
const SEARCH_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 4000;

function timedFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  return fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

interface HfSearchApiItem { id?: string; tags?: string[] }
interface HfTreeItem { type?: string; path?: string; size?: number }

export interface HfSearchEntry { repoId: string }

export type HfSearchCache = Map<string, HfSearchEntry[] | null>;

function sameFile(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (env.HUGGINGFACE_TOKEN) h.Authorization = `Bearer ${env.HUGGINGFACE_TOKEN}`;
  return h;
}

/** Returns an empty array for "no hits", null for 429 / network failures. */
async function search(basename: string): Promise<HfSearchEntry[] | null> {
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(basename)}&limit=${SEARCH_LIMIT}`;
  try {
    const res = await timedFetch(url, authHeaders());
    if (res.status === 429) return null;
    if (!res.ok) return [];
    const body = await res.json() as HfSearchApiItem[] | unknown;
    if (!Array.isArray(body)) return [];
    const out: HfSearchEntry[] = [];
    for (const item of body) {
      const id = typeof (item as HfSearchApiItem).id === 'string'
        ? (item as HfSearchApiItem).id as string
        : '';
      if (id.length > 0) out.push({ repoId: id });
    }
    return out;
  } catch {
    return [];
  }
}

async function treeFiles(repoId: string, revision: string): Promise<HfTreeItem[] | null> {
  const url = `https://huggingface.co/api/models/${encodeURIComponent(repoId)}/tree/${encodeURIComponent(revision)}`;
  try {
    const res = await timedFetch(url, authHeaders());
    if (res.status === 429) return null;
    if (!res.ok) return [];
    const body = await res.json() as HfTreeItem[] | unknown;
    return Array.isArray(body) ? (body as HfTreeItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a filename via HuggingFace search. Returns the resolver's
 * `ResolvedModel` when exactly one match exists across the top MAX_REPOS_PER_SEARCH
 * candidates; null otherwise (including ambiguous and rate-limited states).
 */
export async function hfFindExactMatch(
  filename: string, basename: string, cache: HfSearchCache,
): Promise<ResolvedModel | null> {
  let repos = cache.get(basename);
  if (repos === undefined) {
    const res = await search(basename);
    cache.set(basename, res);
    repos = res;
  }
  if (repos === null || !repos || repos.length === 0) return null;

  let winner: { repoId: string; revision: string; path: string } | null = null;
  let matches = 0;
  for (const repo of repos.slice(0, MAX_REPOS_PER_SEARCH)) {
    if (matches > 1) break;
    const tree = await treeFiles(repo.repoId, 'main');
    if (tree === null) return null;
    for (const item of tree) {
      if (item.type !== 'file') continue;
      const p = typeof item.path === 'string' ? item.path : '';
      const pBase = p.split('/').pop() ?? '';
      if (!sameFile(pBase, filename)) continue;
      matches += 1;
      if (matches > 1) break;
      winner = { repoId: repo.repoId, revision: 'main', path: p };
    }
  }
  if (matches !== 1 || !winner) return null;

  const constructedUrl = `https://huggingface.co/${winner.repoId}/resolve/${encodeURIComponent(winner.revision)}/${winner.path.split('/').map(encodeURIComponent).join('/')}`;
  return resolveHuggingfaceUrl(constructedUrl);
}
