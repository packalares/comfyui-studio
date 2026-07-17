// CivitAI passthrough routes. Forwards to CivitAI's public REST API,
// applies a response-size cap, and wraps in the canonical envelope.
// All list endpoints return `PageEnvelope<CivitaiModelSummary>`.
// `total` is a lower bound — civitai does not expose a total-count field.

import { Router } from 'express';
import * as civitai from '../services/civitai/civitai.service.js';
import type { CivitaiListResponse } from '../services/civitai/models.js';
import {
  CIVITAI_MODEL_TYPES,
  CIVITAI_PERIODS,
  CIVITAI_SORTS,
  type CivitaiPeriod,
  type CivitaiSort,
} from '../services/civitai/models.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { defineRoute } from '../lib/defineRoute.js';
import { ValidationError, HttpError } from '../lib/errors.js';
import {
  CivitaiPageResponseSchema,
  CivitaiModelDetailSchema,
  CivitaiDownloadInfoSchema,
  CivitaiFacetsResponseSchema,
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

function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const arr = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof v === 'string' && v.length > 0) return [v];
  return undefined;
}

const searchModelsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/search',
  query: CivitaiSearchQuerySchema,
  response: CivitaiPageResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Faceted free-text search over civitai models',
}, async (ctx) => {
  const q = ctx.query;
  const query = q.q ?? '';
  const pageSize = intQuery(q.pageSize, intQuery(q.limit, 24), 100);
  const page = intQuery(q.page, 1);
  const cursor = q.cursor;
  // The bracketed alias (`types[]`) gets surfaced as `q['types[]']` by qs;
  // prefer the canonical key when both are present.
  const bracketed = ctx.query as Record<string, unknown>;
  const types = asStringArray(q.types) ?? asStringArray(bracketed['types[]']);
  const baseModels = asStringArray(q.baseModels) ?? asStringArray(bracketed['baseModels[]']);
  const nsfw = q.nsfw === 'true' || q.nsfw === '1';
  // Reject unknown enum values quietly — server won't forward them, UI also
  // won't send them (chips come from /facets), but defence in depth.
  const period = (CIVITAI_PERIODS as readonly string[]).includes(q.period ?? '')
    ? (q.period as CivitaiPeriod) : undefined;
  const sort = (CIVITAI_SORTS as readonly string[]).includes(q.sort ?? '')
    ? (q.sort as CivitaiSort) : undefined;
  try {
    const data = await civitai.searchModels(query, {
      limit: pageSize, cursor, types, baseModels, nsfw, period, sort,
    });
    return ctx.ok(toPageEnvelope(data, { page, pageSize }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Missing search query/.test(msg)) throw new ValidationError(msg);
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const facetsRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/facets',
  response: CivitaiFacetsResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Search vocabulary for the CivitAI filter sidebar',
}, async (ctx) => {
  // baseModels is dynamic — probed off CivitAI's Most-Downloaded slice and
  // cached for 1h. Failures fall back to a small hardcoded list so the UI
  // never breaks (see civitai/facets.ts).
  const baseModels = await civitai.getBaseModelsFacet();
  return ctx.ok({
    types:      Array.from(CIVITAI_MODEL_TYPES),
    baseModels,
    periods:    Array.from(CIVITAI_PERIODS),
    sorts:      Array.from(CIVITAI_SORTS),
  });
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
  // The search schema is shared with /models/search where `q` is optional
  // (filter-only browses are valid). Workflow search has no filter sidebar
  // so an empty query is a user error — fail it explicitly here.
  const query = (ctx.query.q ?? '').trim();
  if (query.length === 0) throw new ValidationError('Missing search query');
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
  // Facets must register before `/:id` so Express matches the literal path first.
  facetsRoute,
  searchModelsRoute,
  modelDetailRoute,
  downloadInfoRoute,
  latestWorkflowsRoute,
  hotWorkflowsRoute,
  searchWorkflowsRoute,
].forEach(r => r.register(router));

export default router;
