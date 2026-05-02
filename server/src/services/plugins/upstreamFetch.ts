// Fetch the live ComfyRegistry catalog from `api.comfy.org/nodes`.
//
// Strategy (per user request):
//   1. Probe with `?limit=10&page=1` to learn `total`.
//   2. Try `?limit=<total>` in a single bulk request — fastest, one
//      round trip.
//   3. If the bulk call fails (most likely cause: server-side limit cap
//      or transient timeout), fall back to paging with `limit=100`.
//
// The returned array is ready to feed into `cache.service::writeMirror(nodes)`,
// which persists it to `server/data/all_nodes.mirrored.json` AND re-seeds
// the SQLite plugins_catalog table. Network failures throw — caller
// decides whether to surface as an error or degrade silently.

import { logger } from '../../lib/logger.js';

const BASE_URL = 'https://api.comfy.org/nodes';
const PROBE_LIMIT = 10;
const FALLBACK_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

interface RegistryEnvelope {
  /** Total number of nodes available across all pages. */
  total: number;
  /** Total pages at the requested `limit`. */
  totalPages: number;
  /** Current page (1-indexed). */
  page: number;
  /** Limit used for this response. */
  limit: number;
  /** Page contents — same shape as our internal `CatalogPlugin`. */
  nodes: Array<Record<string, unknown>>;
}

async function fetchPage(limit: number, page: number): Promise<RegistryEnvelope> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${BASE_URL}?limit=${encodeURIComponent(String(limit))}&page=${page}`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as RegistryEnvelope;
    if (!body || !Array.isArray(body.nodes)) {
      throw new Error('Unexpected response shape: missing nodes[]');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Bulk path — try to get every node in a single call. The registry may
 *  silently cap the response; caller validates the returned count. */
async function fetchAllBulk(total: number): Promise<RegistryEnvelope> {
  return fetchPage(total, 1);
}

/** Pagination fallback. Walks `?limit=100&page=1..N` accumulating every
 *  page's `nodes[]`. Stops if a page returns empty (defensive — total
 *  may have shrunk between probe and walk). */
async function fetchAllPaged(
  total: number, pageSize: number = FALLBACK_PAGE_SIZE,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  for (let p = 1; p <= totalPages; p++) {
    const env = await fetchPage(pageSize, p);
    if (env.nodes.length === 0) break;
    out.push(...env.nodes);
    // Stop early if we've hit the original advertised total — the
    // server may keep returning empty pages otherwise.
    if (out.length >= total) break;
  }
  return out;
}

/**
 * Resolve the full catalog from upstream. Tries bulk-in-one-shot first;
 * falls back to pagination when bulk fails. Throws when both strategies
 * fail (caller handles the degradation — typically by keeping the
 * existing bundled JSON in place).
 */
export async function fetchUpstreamCatalog(): Promise<Array<Record<string, unknown>>> {
  // Probe to learn total size.
  const probe = await fetchPage(PROBE_LIMIT, 1);
  const total = Number(probe.total) || probe.nodes.length;
  logger.info('upstreamCatalog: probe complete', { total });

  if (total <= 0) {
    throw new Error('upstream registry returned total=0');
  }

  // Bulk attempt.
  try {
    const bulk = await fetchAllBulk(total);
    if (bulk.nodes.length >= total) {
      logger.info('upstreamCatalog: bulk fetch succeeded', { count: bulk.nodes.length });
      return bulk.nodes;
    }
    // Server capped the response — we got less than total. Fall through
    // to paging so we don't write a truncated mirror file.
    logger.warn('upstreamCatalog: bulk under-served; falling back to pagination', {
      requested: total, returned: bulk.nodes.length,
    });
  } catch (err) {
    logger.warn('upstreamCatalog: bulk fetch failed; falling back to pagination', {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Pagination fallback.
  const paged = await fetchAllPaged(total);
  logger.info('upstreamCatalog: paged fetch complete', {
    count: paged.length, expected: total,
  });
  return paged;
}
