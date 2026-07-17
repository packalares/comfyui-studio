// Typed wrappers for civitai passthrough routes.

import { z } from 'zod';
import { apiCall } from './client.js';
import type { CivitaiModelSummary, CivitaiDownloadInfo } from '../types/index.js';

// ---- Inline schemas ----

const CivitaiModelSummarySchema = z.object({ id: z.number(), name: z.string() }).passthrough();

const CivitaiPageResponseSchema = z.object({
  items:      z.array(CivitaiModelSummarySchema),
  page:       z.number(),
  pageSize:   z.number(),
  total:      z.number(),
  hasMore:    z.boolean(),
  nextCursor: z.string().optional(),
});

const CivitaiDetailSchema = z.object({ id: z.number().optional(), name: z.string().optional() }).passthrough();

const CivitaiDownloadInfoSchema = z.object({
  id:      z.number().optional(),
  modelId: z.number().optional(),
  name:    z.string().optional(),
}).passthrough();

const pageQuerySchema = z.object({
  limit:    z.string().optional(),
  page:     z.string().optional(),
  cursor:   z.string().optional(),
  pageSize: z.string().optional(),
});

// The bracketed array keys (`types[]`, `baseModels[]`) reach the server as
// `string[]`; the client serialises arrays manually in `buildPageQuery` below
// so the schema only needs to allow the scalar query params.
const searchQuerySchema = pageQuerySchema.extend({
  q:      z.string().optional(),
  nsfw:   z.string().optional(),
  period: z.string().optional(),
  sort:   z.string().optional(),
}).passthrough();
const byUrlQuerySchema = pageQuerySchema.extend({ url: z.string().optional() });

// ---- Route specs ----

const searchModelsSpec = { method: 'GET' as const, path: '/civitai/models/search', query: searchQuerySchema, response: CivitaiPageResponseSchema };
const byUrlSpec        = { method: 'GET' as const, path: '/civitai/models/by-url', query: byUrlQuerySchema,  response: CivitaiPageResponseSchema };

const modelDetailSpec = {
  method: 'GET' as const,
  path: '/civitai/models/:id',
  params: z.object({ id: z.string() }),
  response: CivitaiDetailSchema,
};

const downloadInfoSpec = {
  method: 'GET' as const,
  path: '/civitai/download/models/:versionId',
  params: z.object({ versionId: z.string() }),
  response: CivitaiDownloadInfoSchema,
};

const latestWorkflowsSpec  = { method: 'GET' as const, path: '/civitai/latest-workflows',  query: pageQuerySchema, response: CivitaiPageResponseSchema };
const hotWorkflowsSpec     = { method: 'GET' as const, path: '/civitai/hot-workflows',     query: pageQuerySchema, response: CivitaiPageResponseSchema };
const searchWorkflowsSpec  = { method: 'GET' as const, path: '/civitai/search-workflows',  query: searchQuerySchema, response: CivitaiPageResponseSchema };

// ---- Helpers ----

function buildPageQuery(opts: { page?: number; pageSize?: number; cursor?: string; query?: string }) {
  const q: Record<string, string> = {};
  if (opts.pageSize !== undefined) q.pageSize = String(opts.pageSize);
  if (opts.cursor !== undefined) q.cursor = opts.cursor;
  else if (opts.page !== undefined) q.page = String(opts.page);
  if (opts.query !== undefined && opts.query.length > 0) q.q = opts.query;
  return q;
}

// ---- Public API ----

export interface CivitaiSearchFilters {
  types?: string[];
  baseModels?: string[];
  nsfw?: boolean;
  period?: string;
  sort?: string;
}

export async function searchCivitaiModels(
  query: string,
  opts: { page?: number; pageSize?: number; cursor?: string } & CivitaiSearchFilters = {},
) {
  // `apiCall` from `./client` re-serialises the query record; arrays are
  // emitted via repeated `key[]=v&key[]=v` keys (the exact form CivitAI's
  // API consumes), so the route handler sees them as `types[]` / `baseModels[]`
  // in `ctx.query`.
  const q: Record<string, string | string[]> = { ...buildPageQuery(opts) };
  if (query.length > 0) q.q = query;
  if (opts.types && opts.types.length > 0) q['types[]'] = opts.types;
  if (opts.baseModels && opts.baseModels.length > 0) q['baseModels[]'] = opts.baseModels;
  if (opts.nsfw !== undefined) q.nsfw = String(opts.nsfw);
  if (opts.period) q.period = opts.period;
  if (opts.sort) q.sort = opts.sort;
  return apiCall(searchModelsSpec, { query: q });
}

export async function getCivitaiModelsByUrl(url: string, opts: { page?: number; pageSize?: number } = {}) {
  const q: Record<string, string> = { url };
  if (opts.pageSize !== undefined) q.pageSize = String(opts.pageSize);
  if (opts.page !== undefined) q.page = String(opts.page);
  return apiCall(byUrlSpec, { query: q });
}

export async function getCivitaiModelDetail(id: string | number): Promise<CivitaiDownloadInfo> {
  return apiCall(modelDetailSpec, { params: { id: String(id) } }) as Promise<CivitaiDownloadInfo>;
}

export async function getCivitaiDownloadInfo(versionId: string | number): Promise<CivitaiDownloadInfo> {
  return apiCall(downloadInfoSpec, { params: { versionId: String(versionId) } }) as Promise<CivitaiDownloadInfo>;
}

export async function getLatestWorkflows(opts: { page?: number; pageSize?: number; cursor?: string } = {}) {
  return apiCall(latestWorkflowsSpec, { query: buildPageQuery(opts) });
}

export async function getHotWorkflows(opts: { page?: number; pageSize?: number; cursor?: string } = {}) {
  return apiCall(hotWorkflowsSpec, { query: buildPageQuery(opts) });
}

export async function searchCivitaiWorkflows(query: string, opts: { pageSize?: number; cursor?: string } = {}) {
  return apiCall(searchWorkflowsSpec, { query: { ...buildPageQuery(opts), q: query } });
}
