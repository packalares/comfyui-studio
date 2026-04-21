// New import routes — Phase 1 MVP.
//
//   POST   /templates/import/upload           (multipart .json | .zip)
//   GET    /templates/import/staging/:id
//   POST   /templates/import/staging/:id/commit
//   DELETE /templates/import/staging/:id
//
// Every route dual-mounted at /launcher/... so the catch-all proxy can reach
// it. See `templates.routes.ts` for mount wiring.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import multer from 'multer';
import * as templates from '../services/templates/index.js';
import { resolveModelForStaging, ResolverError } from '../services/templates/commitOverrides.js';
import { CommitBlockedError } from '../services/templates/importCommit.js';
import { sendError } from '../middleware/errors.js';
import { logger } from '../lib/logger.js';

const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});

const router = Router();

function looksLikeZipMime(mime: string, name: string): boolean {
  if (!mime && !name) return false;
  if (/zip/i.test(mime)) return true;
  if (/\.zip$/i.test(name)) return true;
  return false;
}

function looksLikeJsonMime(mime: string, name: string): boolean {
  if (mime === 'application/json') return true;
  if (/\.json$/i.test(name)) return true;
  return false;
}

const handleUpload: RequestHandler = async (req, res) => {
  try {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: 'No file provided (field name: file).' });
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      res.status(413).json({ error: `File exceeds ${UPLOAD_MAX_BYTES} bytes.` });
      return;
    }
    const name = file.originalname;
    const mime = file.mimetype;
    if (looksLikeZipMime(mime, name)) {
      const staged = await templates.stageFromZip(file.buffer, {
        source: 'upload',
        defaultTitle: name.replace(/\.zip$/i, ''),
      });
      if (staged.workflows.length === 0) {
        templates.abortStaging(staged.id);
        res.status(415).json({ error: 'No LiteGraph workflow JSON found inside the zip.' });
        return;
      }
      res.json(templates.toManifest(staged));
      return;
    }
    if (looksLikeJsonMime(mime, name)) {
      let parsed: unknown;
      try { parsed = JSON.parse(file.buffer.toString('utf8')); }
      catch (err) {
        res.status(400).json({
          error: `File is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      if (!templates.looksLikeLitegraph(parsed)) {
        res.status(400).json({ error: 'JSON has no top-level `nodes` array; not a LiteGraph document.' });
        return;
      }
      const staged = await templates.stageFromJson(parsed as Record<string, unknown>, {
        source: 'upload',
        entryName: name,
        defaultTitle: name.replace(/\.json$/i, ''),
      });
      res.json(templates.toManifest(staged));
      return;
    }
    res.status(415).json({ error: 'Only .json or .zip uploads are supported.' });
  } catch (err) {
    logger.warn('templates.import.upload failed', { error: String(err) });
    const msg = err instanceof Error ? err.message : String(err);
    if (/zip exceeds|too many entries|not a LiteGraph/.test(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    sendError(res, err, 500, 'Import upload failed');
  }
};

const handleGetStaging: RequestHandler = (req, res) => {
  const id = String(req.params.id ?? '');
  const staged = templates.getStaging(id);
  if (!staged) {
    res.status(404).json({ error: 'Staging not found or expired' });
    return;
  }
  res.json(templates.toManifest(staged));
};

const handleCommit: RequestHandler = async (req, res) => {
  try {
    const id = String(req.params.id ?? '');
    const body = (req.body || {}) as {
      workflowIndices?: unknown;
      imagesCopy?: unknown;
    };
    const indicesRaw = Array.isArray(body.workflowIndices) ? body.workflowIndices : [];
    const indices: number[] = [];
    for (const raw of indicesRaw) {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (Number.isFinite(n) && n >= 0) indices.push(n);
    }
    if (indices.length === 0) {
      res.status(400).json({ error: 'workflowIndices must be a non-empty array' });
      return;
    }
    const imagesCopy = Boolean(body.imagesCopy);
    const result = await templates.commitStaging(id, { workflowIndices: indices, imagesCopy });
    try { await templates.refreshTemplates(); }
    catch { /* best effort; the UI will still show the new rows after the next GET */ }
    res.json(result);
  } catch (err) {
    if (err instanceof CommitBlockedError) {
      res.status(409).json({
        error: err.message,
        code: 'COMMIT_BLOCKED',
        unresolvedModels: err.unresolvedModels,
        unresolvedPlugins: err.unresolvedPlugins,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/Staging not found/.test(msg)) {
      res.status(404).json({ error: msg });
      return;
    }
    sendError(res, err, 500, 'Import commit failed');
  }
};

const handleResolveModel: RequestHandler = async (req, res) => {
  const id = String(req.params.id ?? '');
  const body = (req.body || {}) as {
    workflowIndex?: unknown;
    missingFileName?: unknown;
    url?: unknown;
  };
  const workflowIndex = typeof body.workflowIndex === 'number'
    ? body.workflowIndex
    : parseInt(String(body.workflowIndex ?? ''), 10);
  const missingFileName = typeof body.missingFileName === 'string' ? body.missingFileName : '';
  const url = typeof body.url === 'string' ? body.url : '';
  if (!Number.isFinite(workflowIndex) || workflowIndex < 0) {
    res.status(400).json({ error: 'workflowIndex must be a non-negative integer', code: 'BAD_INPUT' });
    return;
  }
  if (!missingFileName) {
    res.status(400).json({ error: 'missingFileName is required', code: 'BAD_INPUT' });
    return;
  }
  if (!url) {
    res.status(400).json({ error: 'url is required', code: 'BAD_INPUT' });
    return;
  }
  try {
    const result = await resolveModelForStaging({
      stagingId: id, workflowIndex, missingFileName, url,
    });
    const staged = templates.getStaging(id);
    res.json({
      resolved: result.resolved,
      fileName: result.fileName,
      manifest: staged ? templates.toManifest(staged) : null,
    });
  } catch (err) {
    if (err instanceof ResolverError) {
      const status = err.code === 'UNSUPPORTED_HOST' ? 400
        : err.code === 'STAGING_NOT_FOUND' ? 404
        : err.code === 'WORKFLOW_INDEX_OUT_OF_RANGE' ? 400
        : 422;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    logger.warn('templates.import.resolve-model failed', { error: String(err) });
    sendError(res, err, 500, 'Resolve failed');
  }
};

const handleAbort: RequestHandler = (req, res) => {
  const id = String(req.params.id ?? '');
  const removed = templates.abortStaging(id);
  if (!removed) {
    res.status(404).json({ error: 'Staging not found or expired' });
    return;
  }
  res.json({ aborted: true, id });
};

router.post(
  ['/templates/import/upload', '/launcher/templates/import/upload'],
  upload.single('file'),
  handleUpload,
);
router.get(
  ['/templates/import/staging/:id', '/launcher/templates/import/staging/:id'],
  handleGetStaging,
);
router.post(
  ['/templates/import/staging/:id/commit', '/launcher/templates/import/staging/:id/commit'],
  handleCommit,
);
router.post(
  ['/templates/import/staging/:id/resolve-model', '/launcher/templates/import/staging/:id/resolve-model'],
  handleResolveModel,
);
router.delete(
  ['/templates/import/staging/:id', '/launcher/templates/import/staging/:id'],
  handleAbort,
);

export default router;
