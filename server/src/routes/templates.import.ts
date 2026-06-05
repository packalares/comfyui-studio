// Template import routes — all import sources in one file:
//   POST /templates/import/upload            (multipart .json | .zip)
//   POST /templates/import/staging/:id/commit
//   POST /templates/import/staging/:id/resolve-model
//   DELETE /templates/import/staging/:id
//   POST /templates/import/civitai           (URL-based)
//   POST /templates/import/github
//   POST /templates/import/paste
//
// Legacy versionId-based handler `handleImportCivitai` and `handleDeleteTemplate`
// are exported for `templates.routes.ts` (POST /templates/import-civitai,
// DELETE /templates/:name).

import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import * as templates from '../services/templates/index.js';
import * as templateRepo from '../lib/db/templates.repo.js';
import { resolveModelForStaging, ResolverError } from '../services/templates/commitOverrides.js';
import { CommitBlockedError } from '../services/templates/importCommit.js';
import { WorkflowNameCollisionError } from '../services/templates/errors.js';
import { ImportCivitaiError } from '../services/templates/importCivitaiTemplate.js';
import * as settings from '../services/settings/index.js';
import * as civitai from '../services/civitai/civitai.service.js';
import { fetchWithRetry, getCivitaiAuthHeaders } from '../lib/http.js';
import { hostIsPrivate } from '../lib/security.js';
import { InternalError } from '../lib/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const ZIP_MAX_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});

const router = Router();

// ---- Upload (multipart .json | .zip) ----

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

// Wire shape: `{ "0": "title" }`. Parse keys back to ints, drop non-string values.
function parseTitleOverrides(raw: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const idx = parseInt(k, 10);
    if (Number.isFinite(idx) && idx >= 0 && typeof v === 'string' && v.trim()) out[idx] = v;
  }
  return out;
}

const handleUpload: RequestHandler = async (req, res, next) => {
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
        source: 'upload', defaultTitle: name.replace(/\.zip$/i, ''),
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
      const extracted = templates.extractLitegraph(parsed);
      if (!extracted) {
        res.status(400).json({ error: 'JSON is not a LiteGraph workflow or TemplateData wrapper.' });
        return;
      }
      // Wrapper defaults spread last so explicit author metadata wins.
      const staged = await templates.stageFromJson(extracted.workflow, {
        source: 'upload', entryName: name,
        defaultTitle: name.replace(/\.json$/i, ''),
        ...extracted.defaults,
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
    next(err instanceof Error ? err : new InternalError('Import upload failed'));
  }
};

const handleCommit: RequestHandler = async (req, res, next) => {
  try {
    const id = String(req.params.id ?? '');
    const body = (req.body || {}) as {
      workflowIndices?: unknown;
      imagesCopy?: unknown;
      titleOverrides?: unknown;
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
    const titleOverrides = parseTitleOverrides(body.titleOverrides);
    const result = await templates.commitStaging(id, {
      workflowIndices: indices, imagesCopy, titleOverrides,
    });
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
    if (err instanceof WorkflowNameCollisionError) {
      res.status(409).json({
        error: 'A workflow with this name already exists',
        code: 'NAME_COLLISION',
        existingSlug: err.existingSlug,
        suggestedSlug: err.suggestedSlug,
        workflowIndex: err.workflowIndex,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/Staging not found/.test(msg)) {
      res.status(404).json({ error: msg });
      return;
    }
    next(err instanceof Error ? err : new InternalError('Import commit failed'));
  }
};

const handleResolveModel: RequestHandler = async (req, res, next) => {
  const id = String(req.params.id ?? '');
  const body = (req.body || {}) as { workflowIndex?: unknown; missingFileName?: unknown; url?: unknown };
  const workflowIndex = typeof body.workflowIndex === 'number'
    ? body.workflowIndex : parseInt(String(body.workflowIndex ?? ''), 10);
  const missingFileName = typeof body.missingFileName === 'string' ? body.missingFileName : '';
  const url = typeof body.url === 'string' ? body.url : '';
  if (!Number.isFinite(workflowIndex) || workflowIndex < 0) {
    res.status(400).json({ error: 'workflowIndex must be a non-negative integer', code: 'BAD_INPUT' });
    return;
  }
  if (!missingFileName) { res.status(400).json({ error: 'missingFileName is required', code: 'BAD_INPUT' }); return; }
  if (!url) { res.status(400).json({ error: 'url is required', code: 'BAD_INPUT' }); return; }
  try {
    const result = await resolveModelForStaging({ stagingId: id, workflowIndex, missingFileName, url });
    const staged = templates.getStaging(id);
    res.json({
      resolved: result.resolved, fileName: result.fileName,
      manifest: staged ? templates.toManifest(staged) : null,
    });
  } catch (err) {
    if (err instanceof ResolverError) {
      const status = err.code === 'UNSUPPORTED_HOST' ? 400
        : err.code === 'STAGING_NOT_FOUND' ? 404
        : err.code === 'WORKFLOW_INDEX_OUT_OF_RANGE' ? 400 : 422;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    logger.warn('templates.import.resolve-model failed', { error: String(err) });
    next(err instanceof Error ? err : new InternalError('Resolve failed'));
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

// ---- CivitAI URL-based import ----

// 10 req/min — matches GitHub endpoint pattern.
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

const handleImportCivitaiByUrl: RequestHandler = async (req, res, next) => {
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
      next(err instanceof Error ? err : new InternalError('Import from CivitAI failed'));
      return;
    }
    res.status(mapped.status).json(mapped.body);
  }
};

// ---- CivitAI legacy (versionId-based) ----
// Called by CivitaiTemplateCard via POST /templates/import-civitai.

async function fetchRemoteBytes(
  url: string,
  maxBytes: number,
  extraHeaders: Record<string, string>,
): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: extraHeaders });
    if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`payload too large: ${buf.byteLength} > ${maxBytes}`);
    }
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

/** Pull thumbnail, tags, and description from /models/:id. Silent on failure. */
async function fetchModelExtras(
  modelId: number | null,
  versionId: string,
): Promise<{ thumbnail?: string; tags: string[]; description?: string }> {
  if (!modelId) return { tags: [] };
  try {
    const raw = (await civitai.getModelDetails(String(modelId))) as {
      description?: string | null;
      tags?: unknown;
      modelVersions?: Array<{ id?: number; images?: Array<{ url?: string; type?: string }> }>;
    };
    const versions = Array.isArray(raw.modelVersions) ? raw.modelVersions : [];
    const match = versions.find((v) => String(v.id) === versionId) ?? versions[0];
    const images = Array.isArray(match?.images) ? match.images : [];
    const firstImage = images.find((i) => i && (i.type === 'image' || !i.type) && typeof i.url === 'string');
    const rawTags = Array.isArray(raw.tags) ? raw.tags : [];
    const tags: string[] = [];
    for (const t of rawTags) {
      if (typeof t === 'string' && t.trim()) tags.push(t.trim());
      else if (t && typeof t === 'object') {
        const n = (t as { name?: unknown }).name;
        if (typeof n === 'string' && n.trim()) tags.push(n.trim());
      }
    }
    const desc = typeof raw.description === 'string' ? raw.description.trim() : '';
    return {
      thumbnail: firstImage?.url,
      tags,
      description: desc.length > 0 ? (desc.length > 2000 ? `${desc.slice(0, 2000)}…` : desc) : undefined,
    };
  } catch {
    return { tags: [] };
  }
}

/**
 * Legacy versionId-based import. Resolves version → fetches primary file →
 * stages (JSON single-workflow via stageFromJson, ZIP multi via stageFromZip).
 * Always returns a staged manifest so the Explore card opens the review modal.
 */
export async function handleImportCivitai(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const b = (req.body || {}) as { workflowVersionId?: string | number };
    const versionId = b.workflowVersionId != null ? String(b.workflowVersionId) : '';
    if (!versionId) {
      res.status(400).json({ error: 'workflowVersionId is required' });
      return;
    }

    const meta = await civitai.getWorkflowVersionFile(versionId);
    const civitaiToken = settings.getCivitaiToken();
    const authHeaders = getCivitaiAuthHeaders(meta.downloadUrl, civitaiToken);
    const extras = await fetchModelExtras(meta.modelId, versionId);
    const sourceUrl = `https://civitai.com/models/${meta.modelId ?? ''}?modelVersionId=${versionId}`;
    const defaultTitle = meta.modelName || `CivitAI Workflow ${versionId}`;
    const defaultDescription = extras.description
      ?? `Imported from civitai.com (model version ${versionId}).`;
    const civitaiMeta = meta.modelId != null
      ? {
        modelId: meta.modelId,
        tags: extras.tags.length > 0 ? extras.tags : undefined,
        description: extras.description,
        originalUrl: sourceUrl,
      }
      : undefined;

    let staged;
    if (meta.isJsonFile) {
      const fetched = await fetchWithRetry(meta.downloadUrl, {
        attempts: 3,
        baseDelayMs: 500,
        timeoutMs: 30_000,
        maxBytes: env.CIVITAI_MAX_RESPONSE_BYTES,
        headers: { Accept: 'application/json', ...authHeaders },
      });
      let parsed: unknown;
      try { parsed = JSON.parse(fetched.text); }
      catch (err) {
        res.status(400).json({
          error: `Workflow file was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const extracted = templates.extractLitegraph(parsed);
      if (!extracted) {
        res.status(400).json({
          error: 'Workflow JSON is not a LiteGraph workflow or TemplateData wrapper.',
        });
        return;
      }
      // civitai's API metadata is more authoritative than anything in the JSON wrapper.
      staged = await templates.stageFromJson(extracted.workflow, {
        ...extracted.defaults,
        source: 'civitai',
        sourceUrl,
        entryName: meta.fileName,
        defaultTitle,
        defaultDescription,
        defaultTags: extras.tags.length > 0 ? extras.tags : undefined,
        defaultThumbnail: extras.thumbnail,
      });
    } else {
      const isZip = meta.type === 'Archive' || /\.zip$/i.test(meta.fileName ?? '');
      if (!isZip) {
        res.status(415).json({
          error: 'Unsupported workflow file type.',
          fileName: meta.fileName,
          type: meta.type,
        });
        return;
      }
      let zipBytes: ArrayBuffer;
      try {
        zipBytes = await fetchRemoteBytes(meta.downloadUrl, ZIP_MAX_BYTES, {
          Accept: 'application/octet-stream',
          ...authHeaders,
        });
      } catch (err) {
        res.status(502).json({
          error: `Failed to download zip: ${err instanceof Error ? err.message : String(err)}`,
          fileName: meta.fileName,
        });
        return;
      }
      try {
        staged = await templates.stageFromZip(zipBytes, {
          source: 'civitai',
          sourceUrl,
          defaultTitle,
          defaultDescription,
          defaultTags: extras.tags.length > 0 ? extras.tags : undefined,
          defaultThumbnail: extras.thumbnail,
        });
      } catch (err) {
        res.status(400).json({
          error: `Zip archive could not be opened: ${err instanceof Error ? err.message : String(err)}`,
          fileName: meta.fileName,
        });
        return;
      }
      if (staged.workflows.length === 0) {
        res.status(415).json({
          error: 'No LiteGraph workflow JSON found inside the zip.',
          fileName: meta.fileName,
        });
        return;
      }
    }

    if (civitaiMeta) staged.civitaiMeta = civitaiMeta;
    res.json({ staged: true, manifest: templates.toManifest(staged) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Missing workflow version ID|not valid JSON|no top-level|nodes array|TemplateData wrapper/.test(msg)) {
      res.status(400).json({ error: msg });
      return;
    }
    next(err instanceof Error ? err : new InternalError('Workflow import failed'));
  }
}

/** DELETE /templates/:name — soft-deletes comfy/unknown rows, hard-deletes others. */
export function handleDeleteTemplate(req: Request, res: Response): void {
  const name = req.params.name as string;

  // Look up the DB row to determine source_type.
  const dbRow = templateRepo.getTemplate(name);

  // Also check disk — if neither DB nor disk has this template, 404.
  const onDisk = templates.getUserWorkflowJson(name) !== null;
  if (!dbRow && !onDisk) {
    res.status(404).json({ error: `Template not found: ${name}` });
    return;
  }

  const sourceType = dbRow?.source_type ?? templateRepo.SOURCE_UNKNOWN;

  if (sourceType === templateRepo.SOURCE_COMFY_CATALOG || sourceType === templateRepo.SOURCE_UNKNOWN) {
    // Soft delete: remove the JSON file from disk, mark DB row as soft_deleted.
    // source_type=0 (legacy unknown) is treated the same as comfy-catalog —
    // these rows existed before source tracking was added and were almost
    // certainly comfy-catalog entries; preserving the row lets favorites survive.
    templates.deleteUserWorkflow(name); // remove JSON file from disk
    if (dbRow) {
      templateRepo.setSoftDeleted(name);
    }
    res.json({ deleted: true, soft: true, name });
    return;
  }

  // Hard delete for civitai / github / upload (source_type ∈ {2, 3, 4}).
  const removed = templates.deleteUserWorkflow(name);
  if (!removed && !dbRow) {
    res.status(404).json({ error: `Template not found: ${name}` });
    return;
  }
  if (dbRow) {
    templateRepo.deleteTemplate(name);
  }
  res.json({ deleted: true, soft: false, name });
}

// ---- GitHub + paste-JSON ----

// 10 req/min — GitHub touches upstream.
const githubImportLimiter = rateLimit({ windowMs: 60_000, max: 10 });
// Paste is CPU-only locally; looser budget.
const pasteImportLimiter = rateLimit({ windowMs: 60_000, max: 30 });

function classifyStagingError(err: unknown): { status: number; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Invalid URL|Host not allowed|Unsupported scheme|private\/loopback|Unrecognised GitHub URL/.test(msg)) {
    return { status: 400, error: msg };
  }
  if (/payload too large|not valid JSON|no top-level|LiteGraph|too many entries|zip exceeds|Unsupported content-type|must be a string|No workflow JSON files|All repository candidate files/.test(msg)) {
    return { status: 400, error: msg };
  }
  if (/upstream \d{3}|github listing \d{3}|failed/i.test(msg)) {
    return { status: 502, error: msg };
  }
  return { status: 500, error: msg };
}

const handleGithub: RequestHandler = async (req, res, next) => {
  try {
    const body = (req.body || {}) as { url?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) { res.status(400).json({ error: 'url is required' }); return; }
    // Fast 400 before the service URL parser.
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
      next(err instanceof Error ? err : new InternalError('Import from GitHub failed'));
      return;
    }
    res.status(mapped.status).json({ error: mapped.error });
  }
};

const handlePaste: RequestHandler = async (req, res, next) => {
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
      next(err instanceof Error ? err : new InternalError('Import from paste failed'));
      return;
    }
    res.status(mapped.status).json({ error: mapped.error });
  }
};

// ---- Routes ----

router.post('/templates/import/upload', upload.single('file'), handleUpload);
router.post('/templates/import/staging/:id/commit', handleCommit);
router.post('/templates/import/staging/:id/resolve-model', handleResolveModel);
router.delete('/templates/import/staging/:id', handleAbort);
router.post('/templates/import/civitai', civitaiImportLimiter, handleImportCivitaiByUrl);
router.post('/templates/import/github', githubImportLimiter, handleGithub);
router.post('/templates/import/paste', pasteImportLimiter, handlePaste);

export default router;
