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

const searchQuerySchema = pageQuerySchema.extend({ q: z.string() });
const byUrlQuerySchema = pageQuerySchema.extend({ url: z.string().optional() });

// ---- Route specs ----

const latestModelsSpec = { method: 'GET' as const, path: '/civitai/models/latest', query: pageQuerySchema, response: CivitaiPageResponseSchema };
const hotModelsSpec    = { method: 'GET' as const, path: '/civitai/models/hot',    query: pageQuerySchema, response: CivitaiPageResponseSchema };
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

export async function getLatestModels(opts: { page?: number; pageSize?: number; cursor?: string } = {}) {
  return apiCall(latestModelsSpec, { query: buildPageQuery(opts) });
}

export async function getHotModels(opts: { page?: number; pageSize?: number; cursor?: string } = {}) {
  return apiCall(hotModelsSpec, { query: buildPageQuery(opts) });
}

export async function searchCivitaiModels(query: string, opts: { page?: number; pageSize?: number; cursor?: string } = {}) {
  return apiCall(searchModelsSpec, { query: { ...buildPageQuery(opts), q: query } });
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
