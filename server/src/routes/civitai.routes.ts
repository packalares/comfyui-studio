// CivitAI passthrough routes. Forwards to CivitAI's public REST API,
// applies a response-size cap, and wraps in the canonical envelope.
// All list endpoints return `PageEnvelope<CivitaiModelSummary>`.
// `total` is a lower bound — civitai does not expose a total-count field.

import { Router } from 'express';
import * as civitai from '../services/civitai/civitai.service.js';
import type { CivitaiListResponse } from '../services/civitai/models.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { defineRoute } from '../lib/defineRoute.js';
import { ValidationError, HttpError } from '../lib/errors.js';
import {
  CivitaiPageResponseSchema,
  CivitaiModelDetailSchema,
  CivitaiDownloadInfoSchema,
  CivitaiPageQuerySchema,
  CivitaiSearchQuerySchema,
  CivitaiByUrlQuerySchema,
  CivitaiModelParamsSchema,
  CivitaiVersionParamsSchema,
} from '../contracts/civitai.contract.js';
import type { CivitaiPageResponse } from '../contracts/civitai.contract.js';

// Tighter budget on by-url: accepts an external URL and is the SSRF surface.
const byUrlLimiter = rateLimit('civitai:by-url');

// ---- Helpers ----

function toPageEnvelope(
  raw: CivitaiListResponse,
  requested: { page: number; pageSize: number },
): CivitaiPageResponse {
  const items = Array.isArray(raw.items) ? raw.items : [];
  const meta = raw.metadata ?? {};
  const hasMore = Boolean(meta.nextCursor) || Boolean(meta.nextPage);
  const pageSize = typeof meta.pageSize === 'number' ? meta.pageSize : requested.pageSize;
  const page = typeof meta.currentPage === 'number' ? meta.currentPage : requested.page;
  const priorCount = Math.max(0, (page - 1) * pageSize);
  const total = priorCount + items.length + (hasMore ? 1 : 0);
  const envelope: CivitaiPageResponse = { items: items as CivitaiPageResponse['items'], page, pageSize, total, hasMore };
  if (typeof meta.nextCursor === 'string' && meta.nextCursor.length > 0) {
    envelope.nextCursor = meta.nextCursor;
  }
  return envelope;
}

function intQuery(raw: string | undefined, fallback: number, max = 200): number {
  if (!raw || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parsePageQuery(q: civitai.PageQuery): { page: number; pageSize: number } {
  return { page: q.page ?? 1, pageSize: q.limit ?? 24 };
}

// ---- Routes ----

const byUrlRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/by-url',
  query: CivitaiByUrlQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Proxy a CivitAI search URL',
}, async (ctx) => {
  const url = ctx.query.url ?? '';
  const pageSize = intQuery(ctx.query.pageSize, intQuery(ctx.query.limit, 24), 100);
  const page = intQuery(ctx.query.page, 1);
  try {
    const data = await civitai.getLatestModelsByUrl(url);
    return ctx.ok(toPageEnvelope(data, { page, pageSize }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/host not allowed|Invalid URL|Missing URL/.test(msg)) throw new ValidationError(msg);
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const searchModelsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/search',
  query: CivitaiSearchQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Free-text search over civitai models',
}, async (ctx) => {
  const query = ctx.query.q;
  const pageSize = intQuery(ctx.query.pageSize, intQuery(ctx.query.limit, 24), 100);
  const page = intQuery(ctx.query.page, 1);
  const cursor = ctx.query.cursor;
  try {
    const data = await civitai.searchModels(query, { limit: pageSize, cursor });
    return ctx.ok(toPageEnvelope(data, { page, pageSize }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Missing search query/.test(msg)) throw new ValidationError(msg);
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const latestModelsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/latest',
  query: CivitaiPageQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Newest civitai models',
}, async (ctx) => {
  const q: civitai.PageQuery = {
    limit: ctx.query.limit ? parseInt(ctx.query.limit, 10) : undefined,
    page: ctx.query.page ? parseInt(ctx.query.page, 10) : undefined,
    cursor: ctx.query.cursor,
  };
  try {
    const data = await civitai.getLatestModels(q);
    return ctx.ok(toPageEnvelope(data, parsePageQuery({ ...q, limit: q.limit ?? 12 })));
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const hotModelsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/hot',
  query: CivitaiPageQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Most-downloaded civitai models this month',
}, async (ctx) => {
  const q: civitai.PageQuery = {
    limit: ctx.query.limit ? parseInt(ctx.query.limit, 10) : undefined,
    page: ctx.query.page ? parseInt(ctx.query.page, 10) : undefined,
    cursor: ctx.query.cursor,
  };
  try {
    const data = await civitai.getHotModels(q);
    return ctx.ok(toPageEnvelope(data, parsePageQuery({ ...q, limit: q.limit ?? 24 })));
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const modelDetailRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/:id',
  params: CivitaiModelParamsSchema,
  response: CivitaiModelDetailSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Get civitai model details',
}, async (ctx) => {
  try {
    const data = await civitai.getModelDetails(ctx.params.id);
    return ctx.ok(data as unknown as Record<string, unknown>);
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const downloadInfoRoute = defineRoute({
  method: 'GET',
  path: '/civitai/download/models/:versionId',
  params: CivitaiVersionParamsSchema,
  response: CivitaiDownloadInfoSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Get civitai model version download info',
}, async (ctx) => {
  try {
    const data = await civitai.getModelDownloadInfo(ctx.params.versionId);
    return ctx.ok(data as unknown as Record<string, unknown>);
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const latestWorkflowsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/latest-workflows',
  query: CivitaiPageQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Newest civitai workflows',
}, async (ctx) => {
  const q: civitai.PageQuery = {
    limit: ctx.query.limit ? parseInt(ctx.query.limit, 10) : undefined,
    page: ctx.query.page ? parseInt(ctx.query.page, 10) : undefined,
    cursor: ctx.query.cursor,
  };
  try {
    const data = await civitai.getLatestWorkflows(q);
    return ctx.ok(toPageEnvelope(data, parsePageQuery({ ...q, limit: q.limit ?? 24 })));
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const hotWorkflowsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/hot-workflows',
  query: CivitaiPageQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Hot civitai workflows',
}, async (ctx) => {
  const q: civitai.PageQuery = {
    limit: ctx.query.limit ? parseInt(ctx.query.limit, 10) : undefined,
    page: ctx.query.page ? parseInt(ctx.query.page, 10) : undefined,
    cursor: ctx.query.cursor,
  };
  try {
    const data = await civitai.getHotWorkflows(q);
    return ctx.ok(toPageEnvelope(data, parsePageQuery({ ...q, limit: q.limit ?? 24 })));
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const searchWorkflowsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/search-workflows',
  query: CivitaiSearchQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Free-text search over civitai workflows',
}, async (ctx) => {
  const query = ctx.query.q;
  const pageSize = intQuery(ctx.query.pageSize, intQuery(ctx.query.limit, 24), 100);
  const page = intQuery(ctx.query.page, 1);
  const cursor = ctx.query.cursor;
  try {
    const data = await civitai.searchWorkflows(query, { limit: pageSize, cursor });
    return ctx.ok(toPageEnvelope(data, { page, pageSize }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Missing search query/.test(msg)) throw new ValidationError(msg);
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

// ---- Mount ----
// Literal paths BEFORE /:id so Express matches them first.
const router = Router();

// by-url has its own rate-limiter.
const byUrlLimitedRouter = Router();
byUrlLimitedRouter.get('/civitai/models/by-url', byUrlLimiter, (req, res, next) => {
  const mini = Router();
  byUrlRoute.register(mini);
  mini(req, res, next);
});
router.use(byUrlLimitedRouter);

[
  searchModelsRoute,
  latestModelsRoute,
  hotModelsRoute,
  modelDetailRoute,
  downloadInfoRoute,
  latestWorkflowsRoute,
  hotWorkflowsRoute,
  searchWorkflowsRoute,
].forEach(r => r.register(router));

export default router;
