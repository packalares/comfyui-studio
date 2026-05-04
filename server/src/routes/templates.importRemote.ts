// Handlers + wiring for the GitHub + paste-JSON import tabs.
//
//   POST /templates/import/github  -> body { url }
//   POST /templates/import/paste   -> body { json, title? }
//
// Split from `templates.import.ts` so that file stays under the structure
// line cap.

import { Router, type RequestHandler } from 'express';
import * as templates from '../services/templates/index.js';
import { hostIsPrivate } from '../lib/security.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';
import { logger } from '../lib/logger.js';

// 10 req/min — GitHub fetches touch upstream, so we keep the budget tight.
const githubImportLimiter = rateLimit({ windowMs: 60_000, max: 10 });
// Paste is CPU-only locally, so looser budget.
const pasteImportLimiter = rateLimit({ windowMs: 60_000, max: 30 });

function badRequest(msg: string): { status: number; error: string } {
  return { status: 400, error: msg };
}

/**
 * Map a thrown error from `stageFromRemoteUrl` / `stageFromPastedJson` to an
 * HTTP status. We stay on 400 for anything user-facing (URL shape, payload
 * too large, invalid JSON, not LiteGraph) and 502 for upstream failures.
 */
function classifyStagingError(err: unknown): { status: number; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Invalid URL|Host not allowed|Unsupported scheme|private\/loopback|Unrecognised GitHub URL/.test(msg)) {
    return badRequest(msg);
  }
  if (/payload too large|not valid JSON|no top-level|LiteGraph|too many entries|zip exceeds|Unsupported content-type|must be a string|No workflow JSON files|All repository candidate files/.test(msg)) {
    return badRequest(msg);
  }
  if (/upstream \d{3}|github listing \d{3}|failed/i.test(msg)) {
    return { status: 502, error: msg };
  }
  return { status: 500, error: msg };
}

const handleGithub: RequestHandler = async (req, res) => {
  try {
    const body = (req.body || {}) as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) { res.status(400).json({ error: 'url is required' }); return; }
    // Redundant with the allow-list in the service, but we want a fast 400
    // before the service even touches the URL parser.
    if (hostIsPrivate(url)) {
      res.status(400).json({ error: 'Host resolves to a private/loopback range' });
      return;
    }
    const staged = await templates.stageFromRemoteUrl(url);
    res.json(templates.toManifest(staged));
  } catch (err) {
    logger.warn('templates.import.github failed', { error: String(err) });
    const mapped = classifyStagingError(err);
    if (mapped.status >= 500) {
      sendError(res, err, mapped.status, 'Import from GitHub failed');
      return;
    }
    res.status(mapped.status).json({ error: mapped.error });
  }
};

const handlePaste: RequestHandler = async (req, res) => {
  try {
    const body = (req.body || {}) as { json?: unknown; title?: unknown };
    const json = typeof body.json === 'string' ? body.json : '';
    if (!json) { res.status(400).json({ error: 'json is required' }); return; }
    const title = typeof body.title === 'string' ? body.title : undefined;
    const staged = await templates.stageFromPastedJson(json, { title });
    res.json(templates.toManifest(staged));
  } catch (err) {
    logger.warn('templates.import.paste failed', { error: String(err) });
    const mapped = classifyStagingError(err);
    if (mapped.status >= 500) {
      sendError(res, err, mapped.status, 'Import from paste failed');
      return;
    }
    res.status(mapped.status).json({ error: mapped.error });
  }
};

const router = Router();

router.post('/templates/import/github', githubImportLimiter, handleGithub);
router.post('/templates/import/paste', pasteImportLimiter, handlePaste);

export default router;
