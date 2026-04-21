// CivitAI passthrough routes. Every handler forwards to the CivitAI public
// REST API, applies a response-size cap, and returns JSON to the frontend.
// Endpoints:
//   GET /civitai/models/by-url
//   GET /civitai/models/latest       → PageEnvelope<CivitaiModelSummary>
//   GET /civitai/models/hot          → PageEnvelope<CivitaiModelSummary>
//   GET /civitai/models/search?q=    → PageEnvelope<CivitaiModelSummary>
//   GET /civitai/models/:id
//   GET /civitai/download/models/:versionId
//   GET /civitai/latest-workflows    → PageEnvelope<CivitaiModelSummary>
//   GET /civitai/hot-workflows       → PageEnvelope<CivitaiModelSummary>
//
// PageEnvelope shape (Phase 8):
//   { items, page, pageSize, total, hasMore }
// `total` is a LOWER BOUND because civitai does not expose a total-count
// field on its list responses (see services/civitai/models.ts header for
// details). Consumers should rely on `hasMore` for pagination.
//
// Dual-mounted with the legacy `/launcher/civitai/...` aliases so the
// catch-all proxy never sees this traffic.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as civitai from '../services/civitai/civitai.service.js';
import type { CivitaiListResponse } from '../services/civitai/models.js';
import { sendError } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Tighter budget on by-url: it accepts an external URL and is the SSRF surface.
const byUrlLimiter = rateLimit({ windowMs: 60_000, max: 30 });

function parseQuery(req: Request): civitai.PageQuery {
  return {
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
    page: req.query.page ? parseInt(String(req.query.page), 10) : undefined,
    cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
  };
}

/**
 * Derive a PageEnvelope from a civitai list response. Fields read:
 *   - `items` (array, required)
 *   - `metadata.nextCursor` / `metadata.nextPage` — presence => hasMore=true
 *   - `metadata.currentPage` / `metadata.pageSize` — echoed if present,
 *     otherwise we fall back to the caller's requested values.
 *
 * `total` is synthesised. Since civitai refuses to disclose a total count,
 * we report the best lower bound: already-seen rows + current page length,
 * plus 1 when another page exists. Consumers should treat `total` as
 * advisory and use `hasMore` for pagination decisions.
 */
function toPageEnvelope<T = unknown>(
  raw: CivitaiListResponse,
  requested: { page: number; pageSize: number },
): { items: T[]; page: number; pageSize: number; total: number; hasMore: boolean; nextCursor?: string } {
  const items = Array.isArray(raw.items) ? (raw.items as T[]) : [];
  const meta = raw.metadata ?? {};
  const hasMore = Boolean(meta.nextCursor) || Boolean(meta.nextPage);
  const pageSize = typeof meta.pageSize === 'number' ? meta.pageSize : requested.pageSize;
  const page = typeof meta.currentPage === 'number' ? meta.currentPage : requested.page;
  const priorCount = Math.max(0, (page - 1) * pageSize);
  const total = priorCount + items.length + (hasMore ? 1 : 0);
  const envelope: { items: T[]; page: number; pageSize: number; total: number; hasMore: boolean; nextCursor?: string } = {
    items, page, pageSize, total, hasMore,
  };
  // Surface the cursor so Wave J "Load more" can thread it on search calls
  // (CivitAI rejects `page=` alongside `query=` so search relies on it).
  if (typeof meta.nextCursor === 'string' && meta.nextCursor.length > 0) {
    envelope.nextCursor = meta.nextCursor;
  }
  return envelope;
}

function handleUpstream(res: Response, err: unknown): void {
  // Hide upstream detail in prod; sendError already strips it.
  sendError(res, err, 502, 'Civitai request failed');
}

function readIntQuery(req: Request, key: string, fallback: number, max = 200): number {
  const raw = req.query[key];
  if (typeof raw !== 'string' || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

const handleLatestModels: RequestHandler = async (req, res) => {
  try {
    const q = parseQuery(req);
    const page = q.page ?? 1;
    const pageSize = q.limit ?? 12;
    const data = await civitai.getLatestModels(q);
    res.json(toPageEnvelope(data, { page, pageSize }));
  } catch (err) { handleUpstream(res, err); }
};

const handleHotModels: RequestHandler = async (req, res) => {
  try {
    const q = parseQuery(req);
    const page = q.page ?? 1;
    const pageSize = q.limit ?? 24;
    const data = await civitai.getHotModels(q);
    res.json(toPageEnvelope(data, { page, pageSize }));
  } catch (err) { handleUpstream(res, err); }
};

const handleSearchModels: RequestHandler = async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (!query.trim()) {
      res.status(400).json({ error: 'Query parameter `q` is required' });
      return;
    }
    const pageSize = readIntQuery(req, 'pageSize', readIntQuery(req, 'limit', 24), 100);
    const page = readIntQuery(req, 'page', 1);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const data = await civitai.searchModels(query, { limit: pageSize, cursor });
    res.json(toPageEnvelope(data, { page, pageSize }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Missing search query/.test(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    handleUpstream(res, err);
  }
};

const handleModelDetails: RequestHandler = async (req, res) => {
  try {
    const id = String(req.params.id ?? '');
    const data = await civitai.getModelDetails(id);
    res.json(data);
  } catch (err) { handleUpstream(res, err); }
};

const handleDownloadModelInfo: RequestHandler = async (req, res) => {
  try {
    const versionId = String(req.params.versionId ?? '');
    const data = await civitai.getModelDownloadInfo(versionId);
    res.json(data);
  } catch (err) { handleUpstream(res, err); }
};

const handleByUrl: RequestHandler = async (req, res) => {
  try {
    const fullUrl = typeof req.query.url === 'string' ? req.query.url : '';
    const data = await civitai.getLatestModelsByUrl(fullUrl);
    const pageSize = readIntQuery(req, 'pageSize', readIntQuery(req, 'limit', 24), 100);
    const page = readIntQuery(req, 'page', 1);
    res.json(toPageEnvelope(data, { page, pageSize }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 400 on validation errors; 502 on upstream network issues.
    if (/host not allowed|Invalid URL|Missing URL/.test(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    handleUpstream(res, err);
  }
};

const handleLatestWorkflows: RequestHandler = async (req, res) => {
  try {
    const q = parseQuery(req);
    const page = q.page ?? 1;
    const pageSize = q.limit ?? 24;
    const data = await civitai.getLatestWorkflows(q);
    res.json(toPageEnvelope(data, { page, pageSize }));
  } catch (err) { handleUpstream(res, err); }
};

const handleHotWorkflows: RequestHandler = async (req, res) => {
  try {
    const q = parseQuery(req);
    const page = q.page ?? 1;
    const pageSize = q.limit ?? 24;
    const data = await civitai.getHotWorkflows(q);
    res.json(toPageEnvelope(data, { page, pageSize }));
  } catch (err) { handleUpstream(res, err); }
};

const handleSearchWorkflows: RequestHandler = async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (!query.trim()) {
      res.status(400).json({ error: 'Query parameter `q` is required' });
      return;
    }
    const pageSize = readIntQuery(req, 'pageSize', readIntQuery(req, 'limit', 24), 100);
    const page = readIntQuery(req, 'page', 1);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const data = await civitai.searchWorkflows(query, { limit: pageSize, cursor });
    res.json(toPageEnvelope(data, { page, pageSize }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Missing search query/.test(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    handleUpstream(res, err);
  }
};

// ---- Mount canonical + legacy aliases ----
// Literal paths are listed BEFORE `/models/:id` so Express matches them first.
router.get(['/civitai/models/by-url', '/launcher/civitai/models/by-url'], byUrlLimiter, handleByUrl);
router.get(['/civitai/models/search', '/launcher/civitai/models/search'], handleSearchModels);
router.get(['/civitai/models/latest', '/launcher/civitai/models/latest'], handleLatestModels);
router.get(['/civitai/models/hot', '/launcher/civitai/models/hot'], handleHotModels);
router.get(['/civitai/models/:id', '/launcher/civitai/models/:id'], handleModelDetails);
router.get(
  ['/civitai/download/models/:versionId', '/launcher/civitai/download/models/:versionId'],
  handleDownloadModelInfo,
);
router.get(['/civitai/latest-workflows', '/launcher/civitai/latest-workflows'], handleLatestWorkflows);
router.get(['/civitai/hot-workflows', '/launcher/civitai/hot-workflows'], handleHotWorkflows);
router.get(['/civitai/search-workflows', '/launcher/civitai/search-workflows'], handleSearchWorkflows);

export default router;
