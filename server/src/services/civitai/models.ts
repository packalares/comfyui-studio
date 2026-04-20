// CivitAI "models" endpoints. GET-only, no auth. Ports launcher's
// `controllers/civitai/models.ts` 1:1, using `fetchWithRetry` with a response
// size cap so large upstream payloads cannot exhaust memory.

import { env } from '../../config/env.js';
import { fetchWithRetry } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';

export interface PageQuery {
  limit?: number;
  page?: number;
  cursor?: string;
}

interface QueryParams {
  [key: string]: string | number | boolean;
}

function apiBase(): string { return env.CIVITAI_API_BASE; }
function maxBytes(): number { return env.CIVITAI_MAX_RESPONSE_BYTES; }

/** Build a query string from a params record. */
export function encodeQuery(params: QueryParams): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const r = await fetchWithRetry(url, {
    attempts: 3,
    baseDelayMs: 500,
    timeoutMs: 15_000,
    maxBytes: maxBytes(),
    headers: { Accept: 'application/json' },
  });
  try { return JSON.parse(r.text); }
  catch (err) {
    throw new Error(`Civitai response was not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Shared page-params builder. */
function pageParams(q: PageQuery, defaultLimit: number): QueryParams {
  const limit = Number.isFinite(q.limit) ? Number(q.limit) : defaultLimit;
  const out: QueryParams = { limit };
  if (q.cursor) out.cursor = q.cursor;
  else out.page = Number.isFinite(q.page) ? Number(q.page) : 1;
  return out;
}

/** Latest models, sorted Newest. */
export async function getLatestModels(q: PageQuery): Promise<unknown> {
  const params: QueryParams = {
    ...pageParams(q, 12),
    sort: 'Newest',
    period: 'AllTime',
    nsfw: false,
  };
  logger.info('civitai latest models', params);
  return fetchJson(`${apiBase()}/models${encodeQuery(params)}`);
}

/** Hot models, sorted by Most Downloaded last month. */
export async function getHotModels(q: PageQuery): Promise<unknown> {
  const params: QueryParams = {
    ...pageParams(q, 24),
    sort: 'Most Downloaded',
    period: 'Month',
    nsfw: false,
  };
  logger.info('civitai hot models', params);
  return fetchJson(`${apiBase()}/models${encodeQuery(params)}`);
}

/** Model details by ID. */
export async function getModelDetails(modelId: string): Promise<unknown> {
  if (!modelId) throw new Error('Missing model ID');
  logger.info('civitai model details', { modelId });
  return fetchJson(`${apiBase()}/models/${encodeURIComponent(modelId)}`);
}

/** Proxy the versionId -> download metadata endpoint. */
export async function getModelDownloadInfo(versionId: string): Promise<unknown> {
  if (!versionId) throw new Error('Missing model version ID');
  logger.info('civitai model download', { versionId });
  return fetchJson(`${apiBase()}/download/models/${encodeURIComponent(versionId)}`);
}

/** Pass-through by URL (frontend supplies its own pagination URL). */
export async function getLatestModelsByUrl(fullUrl: string): Promise<unknown> {
  if (!fullUrl) throw new Error('Missing URL parameter');
  let parsed: URL;
  try { parsed = new URL(fullUrl); }
  catch { throw new Error('Invalid URL format'); }
  // Only permit direct CivitAI hostnames to avoid turning this into an SSRF.
  const host = parsed.hostname.toLowerCase();
  if (host !== 'civitai.com' && host !== 'www.civitai.com') {
    throw new Error('URL host not allowed');
  }
  const params: QueryParams = {};
  parsed.searchParams.forEach((v, k) => { params[k] = v; });
  logger.info('civitai models by url', { params });
  return fetchJson(`${apiBase()}/models${encodeQuery(params)}`);
}
