// CivitAI "models" endpoints. GET-only, no auth. Ports launcher's
// `controllers/civitai/models.ts` 1:1, using `fetchWithRetry` with a response
// size cap so large upstream payloads cannot exhaust memory.
//
// Pagination note verified against a live civitai response (2026-04):
//   civitai's /models endpoint returns `{ items, metadata: { nextCursor?,
//   nextPage?, currentPage?, pageSize? } }`. There is NO `totalItems` /
//   `totalPages` field — civitai is cursor-based and does not disclose the
//   full result count. Route wrappers therefore synthesise `total` as
//   `(page-1)*pageSize + items.length + (hasMore ? 1 : 0)` to remain shaped
//   as `PageEnvelope<T>`; callers treat `total` as a lower bound and trust
//   `hasMore` for "is there a next page" decisions.
//
// When `query=` is present civitai REQUIRES cursor-based pagination and
// rejects `page=` with `{"error":"Cannot use page param with query search.
// Use cursor-based pagination."}`. Our `searchModels` helper therefore never
// emits `page=` alongside `query=`.

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

/** Raw civitai metadata shape. `totalItems`/`totalPages` are NOT exposed. */
export interface CivitaiMetadata {
  currentPage?: number;
  pageSize?: number;
  nextCursor?: string;
  nextPage?: string;
  prevPage?: string;
}

export interface CivitaiListResponse {
  items: unknown[];
  metadata?: CivitaiMetadata;
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

/** Documented CivitAI enums — keep here so the facets endpoint can expose them
 *  to the UI without hardcoding chip lists on the frontend. */
export const CIVITAI_MODEL_TYPES = [
  'Checkpoint',
  'TextualInversion',
  'Hypernetwork',
  'AestheticGradient',
  'LORA',
  'LoCon',
  'Controlnet',
  'Upscaler',
  'MotionModule',
  'VAE',
  'Poses',
  'Wildcards',
  'Workflows',
  'Other',
] as const;
export const CIVITAI_PERIODS = ['AllTime', 'Year', 'Month', 'Week', 'Day'] as const;
export const CIVITAI_SORTS = ['Highest Rated', 'Most Downloaded', 'Newest'] as const;
// `CIVITAI_BASE_MODELS_FALLBACK` lives in ./facets.ts so the cache + probe +
// fallback list stay co-located; import from there if you need it.

export type CivitaiModelType = (typeof CIVITAI_MODEL_TYPES)[number];
export type CivitaiPeriod = (typeof CIVITAI_PERIODS)[number];
export type CivitaiSort = (typeof CIVITAI_SORTS)[number];

/** Optional, user-controllable filters layered on top of the free-text query. */
export interface SearchFilters {
  types?: string[];
  baseModels?: string[];
  nsfw?: boolean;
  period?: CivitaiPeriod;
  sort?: CivitaiSort;
}

/** Append `key=value` parts for CivitAI's repeated-key array encoding.
 *  Verified against the live API: `baseModels[]=Flux.1 D` silently returns
 *  unfiltered results, while `baseModels=Flux.1 D` (no brackets) actually
 *  filters. Multiple values are sent as repeated keys
 *  (`baseModels=A&baseModels=B`). */
function appendArrayQuery(parts: string[], key: string, values: string[]): void {
  for (const v of values) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
}

/**
 * Free-text + faceted model search. Civitai rejects `page=` when `query=` is
 * set (see file header), so this helper always passes a cursor when provided
 * and otherwise omits the pagination token — the first hit returns
 * `nextCursor` which subsequent calls thread through.
 */
export async function searchModels(
  query: string,
  q: PageQuery & SearchFilters,
): Promise<CivitaiListResponse> {
  const trimmed = query ? query.trim() : '';
  // Empty query is allowed when at least one filter is set — that's how the UI
  // "browse by Type=LORA" use case lands. We only reject when the caller asks
  // for nothing at all.
  const hasFilters = Boolean(
    (q.types && q.types.length > 0)
    || (q.baseModels && q.baseModels.length > 0)
    || q.period
    || q.sort
    || q.nsfw,
  );
  if (trimmed.length === 0 && !hasFilters) {
    throw new Error('Missing search query');
  }
  const limit = Number.isFinite(q.limit) ? Number(q.limit) : 24;
  const params: QueryParams = {
    limit,
    sort: q.sort ?? 'Highest Rated',
    period: q.period ?? 'AllTime',
    nsfw: q.nsfw === true,
  };
  if (trimmed.length > 0) params.query = trimmed;
  if (q.cursor) params.cursor = q.cursor;
  const baseParts = encodeQuery(params).slice(1).split('&').filter(Boolean);
  if (q.types && q.types.length > 0) appendArrayQuery(baseParts, 'types', q.types);
  if (q.baseModels && q.baseModels.length > 0) appendArrayQuery(baseParts, 'baseModels', q.baseModels);
  const qs = baseParts.length === 0 ? '' : `?${baseParts.join('&')}`;
  logger.info('civitai search models', {
    query: trimmed, limit, cursor: q.cursor ?? null,
    types: q.types ?? null, baseModels: q.baseModels ?? null,
    period: params.period, sort: params.sort, nsfw: params.nsfw,
  });
  return (await fetchJson(`${apiBase()}/models${qs}`)) as CivitaiListResponse;
}


/** Model details by ID. */
export async function getModelDetails(modelId: string): Promise<unknown> {
  if (!modelId) throw new Error('Missing model ID');
  logger.info('civitai model details', { modelId });
  return fetchJson(`${apiBase()}/models/${encodeURIComponent(modelId)}`);
}

/**
 * Look up a model version and return the download URL + file metadata.
 *
 * Uses `/model-versions/:id` (JSON), not `/download/models/:id` (which is a
 * 301 redirect to the binary file and returns HTML 404 for gated models).
 */
export async function getModelDownloadInfo(versionId: string): Promise<unknown> {
  if (!versionId) throw new Error('Missing model version ID');
  logger.info('civitai model download', { versionId });
  const data = await fetchJson(`${apiBase()}/model-versions/${encodeURIComponent(versionId)}`);
  const d = data as Record<string, unknown>;
  const files = Array.isArray(d.files) ? d.files as Array<Record<string, unknown>> : [];
  const primary = files.find((f) => f.primary === true) ?? files[0];
  if (!primary) {
    return {
      versionId,
      name: typeof d.name === 'string' ? d.name : '',
      downloadUrl: null,
      files: [],
    };
  }
  return {
    versionId,
    name: typeof d.name === 'string' ? d.name : (typeof primary.name === 'string' ? primary.name : ''),
    modelName: typeof primary.name === 'string' ? primary.name : '',
    downloadUrl: typeof primary.downloadUrl === 'string' ? primary.downloadUrl : null,
    sizeKB: typeof primary.sizeKB === 'number' ? primary.sizeKB : null,
    type: typeof primary.type === 'string' ? primary.type : null,
    format: typeof (primary.metadata as Record<string, unknown> | undefined)?.format === 'string'
      ? ((primary.metadata as Record<string, unknown>).format as string)
      : null,
    files,
  };
}

/** Pass-through by URL (frontend supplies its own pagination URL). */
export async function getLatestModelsByUrl(fullUrl: string): Promise<CivitaiListResponse> {
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
  return (await fetchJson(`${apiBase()}/models${encodeQuery(params)}`)) as CivitaiListResponse;
}
