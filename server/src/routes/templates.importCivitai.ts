// CivitAI import routes.
//
// Wave J ships a URL-based handler (`POST /templates/import/civitai`) that
// stages a workflow via the shared staging pipeline; older code continues
// to call the versionId-based `POST /templates/import-civitai` handler
// (`handleImportCivitai`) registered in `templates.routes.ts`.
//
// Legacy handlers live in `templates.importCivitai.legacy.ts` — this file
// re-exports them unchanged so the route wiring keeps working.

import { Router, type RequestHandler } from 'express';
import * as templates from '../services/templates/index.js';
import { ImportCivitaiError } from '../services/templates/importCivitaiTemplate.js';
import { sendError } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';

export { handleImportCivitai, handleDeleteTemplate } from './templates.importCivitai.legacy.js';

// 10 req/min — matches Phase 3's github endpoint pattern.
const civitaiImportLimiter = rateLimit({ windowMs: 60_000, max: 10 });

function mapImportCivitaiError(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (err instanceof ImportCivitaiError) {
    switch (err.code) {
      case 'UNSUPPORTED_URL':
        return { status: 400, body: { error: err.message, code: err.code } };
      case 'NO_WORKFLOW_FOUND':
        return { status: 422, body: { error: err.message, code: err.code } };
      case 'UPSTREAM_NOT_FOUND':
        return { status: 404, body: { error: err.message, code: err.code } };
      case 'PAYLOAD_TOO_LARGE':
        return { status: 413, body: { error: err.message, code: err.code } };
      case 'UPSTREAM_FAILURE':
      default:
        return { status: 502, body: { error: err.message, code: err.code } };
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: msg } };
}

const handleImportCivitaiByUrl: RequestHandler = async (req, res) => {
  try {
    const body = (req.body || {}) as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const staged = await templates.stageFromCivitaiUrl(url);
    res.json(templates.toManifest(staged));
  } catch (err) {
    logger.warn('templates.import.civitai failed', { error: String(err) });
    const mapped = mapImportCivitaiError(err);
    if (mapped.status >= 500) {
      sendError(res, err, mapped.status, 'Import from CivitAI failed');
      return;
    }
    res.status(mapped.status).json(mapped.body);
  }
};

const router = Router();
router.post(
  ['/templates/import/civitai', '/launcher/templates/import/civitai'],
  civitaiImportLimiter,
  handleImportCivitaiByUrl,
);

export default router;
