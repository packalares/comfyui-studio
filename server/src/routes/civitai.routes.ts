// CivitAI passthrough routes. Every handler forwards to the CivitAI public
// REST API, applies a response-size cap, and returns JSON to the frontend.
// Endpoints preserved exactly from the launcher proxy:
//   GET /civitai/models/by-url
//   GET /civitai/models/latest
//   GET /civitai/models/hot
//   GET /civitai/models/:id
//   GET /civitai/download/models/:versionId
//   GET /civitai/latest-workflows
//   GET /civitai/hot-workflows
//
// Dual-mounted with the legacy `/launcher/civitai/...` aliases per Agent G/H
// pattern so the catch-all proxy stops seeing this traffic.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as civitai from '../services/civitai/civitai.service.js';
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

function handleUpstream(res: Response, err: unknown): void {
  // Hide upstream detail in prod; sendError already strips it.
  sendError(res, err, 502, 'Civitai request failed');
}

const handleLatestModels: RequestHandler = async (req, res) => {
  try {
    const data = await civitai.getLatestModels(parseQuery(req));
    res.json(data);
  } catch (err) { handleUpstream(res, err); }
};

const handleHotModels: RequestHandler = async (req, res) => {
  try {
    const data = await civitai.getHotModels(parseQuery(req));
    res.json(data);
  } catch (err) { handleUpstream(res, err); }
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
    res.json(data);
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
    const data = await civitai.getLatestWorkflows(parseQuery(req));
    res.json(data);
  } catch (err) { handleUpstream(res, err); }
};

const handleHotWorkflows: RequestHandler = async (req, res) => {
  try {
    const data = await civitai.getHotWorkflows(parseQuery(req));
    res.json(data);
  } catch (err) { handleUpstream(res, err); }
};

// ---- Mount canonical + legacy aliases ----
// `/models/by-url` is listed BEFORE the parametrized `/models/:id` so Express
// matches the literal path first.
router.get(['/civitai/models/by-url', '/launcher/civitai/models/by-url'], byUrlLimiter, handleByUrl);
router.get(['/civitai/models/latest', '/launcher/civitai/models/latest'], handleLatestModels);
router.get(['/civitai/models/hot', '/launcher/civitai/models/hot'], handleHotModels);
router.get(['/civitai/models/:id', '/launcher/civitai/models/:id'], handleModelDetails);
router.get(
  ['/civitai/download/models/:versionId', '/launcher/civitai/download/models/:versionId'],
  handleDownloadModelInfo,
);
router.get(['/civitai/latest-workflows', '/launcher/civitai/latest-workflows'], handleLatestWorkflows);
router.get(['/civitai/hot-workflows', '/launcher/civitai/hot-workflows'], handleHotWorkflows);

export default router;
