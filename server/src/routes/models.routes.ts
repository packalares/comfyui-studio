// Model management routes. Backed by local services (ported from launcher's
// models + download + essential-models controllers). The /launcher/... aliases
// are preserved for studio's existing frontend; new canonical paths live at
// /api/models/... via the handlers below.
//
// NOTE on /models/download-custom (unified downloader):
//   The `hfUrl` request-body field is historical; it now accepts both
//   huggingface.co / hf-mirror.com URLs and civitai.com URLs of the form
//   `https://civitai.com/api/download/models/:versionId`. The handler routes
//   each to the correct auth header (HF vs CivitAI bearer token).
//   CivitAI downloads MUST include an explicit `filename` body field — the
//   civitai URL itself does not encode the filename (it arrives via
//   Content-Disposition on the 302 redirect).

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as models from '../services/models/models.service.js';
import { toWireEntry } from '../services/models/models.wire.js';
import * as settings from '../services/settings.js';
import {
  enqueueDownload, findByIdentity, findQueuedByIdentity, isAtCapacity,
  stopTracking, trackDownload,
} from '../services/downloads.js';
import {
  listHistory, clearHistory, deleteHistoryItem,
} from '../services/downloadController/downloadHistory.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';
import { hostIsPrivate, isHttpUrl } from './models.validation.js';
import { parsePageQuery, paginate } from '../lib/pagination.js';
import { prepopulateCatalog, type DownloadCustomMeta } from './models.prepopulate.js';

// Re-export for tests and backward-compat callers.
export { hostIsPrivate };

const router = Router();

// 30 req/min per IP. download-custom triggers upstream HTTP fetches, so the
// budget is tighter than /generate.
const downloadCustomLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// ---- Handlers ----

const handleGetModels: RequestHandler = async (_req, res) => {
  try {
    const list = await models.scanAndRefresh();
    res.json(list.map(toWireEntry));
  } catch (err) { sendError(res, err, 500, 'Failed to read model list'); }
};

const handleScan: RequestHandler = async (_req, res) => {
  try {
    const r = await models.scan();
    res.json({ success: true, count: r.count, models: r.models.map(toWireEntry) });
  } catch (err) { sendError(res, err, 500, 'Scan failed'); }
};

const handleDelete: RequestHandler = async (req, res) => {
  const { modelName } = (req.body || {}) as { modelName?: string };
  if (!modelName) { res.status(400).json({ error: 'Missing model name' }); return; }
  try {
    const r = await models.deleteByName(modelName);
    if (!r.success) { res.status(400).json({ success: false, error: r.message }); return; }
    res.json({ success: true, message: r.message });
  } catch (err) { sendError(res, err, 500, 'Delete failed'); }
};

const handleCancel: RequestHandler = async (req, res) => {
  const { taskId, modelName } = (req.body || {}) as { taskId?: string; modelName?: string };
  if (!taskId && !modelName) { res.status(400).json({ error: 'Missing model name or task ID' }); return; }
  const r = models.cancelDownload({ taskId, modelName });
  if (taskId) stopTracking(taskId);
  if (!r.success) { res.status(404).json({ success: false, error: r.message }); return; }
  res.json({ success: true, message: r.message });
};

const handleInstall: RequestHandler = async (req, res) => {
  try {
    const modelName = req.params.modelName as string;
    const { source = 'hf' } = (req.body || {}) as { source?: string };
    const existing = findByIdentity({ modelName });
    if (existing) {
      res.json({ success: true, taskId: existing.taskId, alreadyActive: true });
      return;
    }
    const hfToken = settings.getHfToken();
    const { taskId } = await models.installFromCatalog(modelName, source, hfToken);
    trackDownload(taskId, { modelName });
    res.json({ success: true, taskId, message: `Starting model download: ${modelName}` });
  } catch (err) { sendError(res, err, 500, 'Install failed'); }
};

const handleProgress: RequestHandler = async (req, res) => {
  const id = req.params.id as string;
  const p = models.getProgress(id);
  if (!p) {
    res.status(404).json({
      error: `Progress not found for id ${id}`,
      overallProgress: 0, status: 'unknown', completed: false,
      totalBytes: 0, downloadedBytes: 0, speed: 0,
    });
    return;
  }
  res.json({
    overallProgress: p.overallProgress || 0,
    currentModelIndex: p.currentModelIndex || 0,
    currentModelProgress: p.currentModelProgress || 0,
    currentModel: p.currentModel ? { ...p.currentModel } : null,
    completed: p.completed || false,
    error: p.error || null,
    totalBytes: p.totalBytes || 0,
    downloadedBytes: p.downloadedBytes || 0,
    speed: p.speed || 0,
    status: p.status || 'downloading',
  });
};

const handleHistory: RequestHandler = async (req, res) => {
  try {
    const history = listHistory();
    const pq = parsePageQuery(req, { defaultPageSize: 20, maxPageSize: 100 });
    if (!pq.isPaginated) {
      res.json({ success: true, count: history.length, history });
      return;
    }
    const env = paginate(history, pq.page, pq.pageSize);
    res.json({ success: true, count: env.total, ...env });
  } catch (err) { sendError(res, err, 500, 'History read failed'); }
};

const handleHistoryClear: RequestHandler = async (_req, res) => {
  try { clearHistory(); res.json({ success: true, message: 'History cleared' }); }
  catch (err) { sendError(res, err, 500, 'Clear failed'); }
};

const handleHistoryDelete: RequestHandler = async (req, res) => {
  const { id } = (req.body || {}) as { id?: string };
  if (!id) { res.status(400).json({ success: false, message: 'History id required' }); return; }
  const removed = deleteHistoryItem(id);
  if (!removed) { res.status(404).json({ success: false, message: 'History item not found' }); return; }
  res.json({ success: true, message: `History item deleted: ${removed.modelName}` });
};

// Allow-listed hosts for the unified download endpoint. `hfUrl` retains its
// historical name but now accepts huggingface + civitai URLs; see the doc
// block at the top of the file.
const DOWNLOAD_ALLOWED_HOSTS = new Set([
  'huggingface.co', 'www.huggingface.co', 'hf-mirror.com',
  'civitai.com', 'www.civitai.com',
]);

function isAllowedDownloadHost(url: string): boolean {
  try { return DOWNLOAD_ALLOWED_HOSTS.has(new URL(url).hostname.toLowerCase()); }
  catch { return false; }
}

const handleDownloadCustom: RequestHandler = async (req: Request, res: Response) => {
  try {
    const { modelName, filename, hfUrl, modelDir, hfToken, civitaiToken, meta } = (req.body || {}) as {
      modelName?: string; filename?: string; hfUrl?: string; modelDir?: string;
      hfToken?: string; civitaiToken?: string; meta?: DownloadCustomMeta;
    };
    if (hfUrl !== undefined && !isHttpUrl(hfUrl)) { res.status(400).json({ error: 'hfUrl must be http(s)' }); return; }
    if (hfUrl !== undefined && hostIsPrivate(hfUrl)) { res.status(400).json({ error: 'hfUrl points at a private/loopback host' }); return; }
    if (hfUrl !== undefined && !isAllowedDownloadHost(hfUrl)) {
      res.status(400).json({ error: 'hfUrl host not allowed (huggingface.co, hf-mirror.com, civitai.com only)' });
      return;
    }
    // Resolve filename. HF URLs encode it in the last path segment; civitai
    // `/api/download/models/:versionId` does NOT — caller must supply it
    // explicitly. We accept either an explicit `filename` or derive from HF.
    let resolvedFilename = filename;
    if (!resolvedFilename && hfUrl) {
      try {
        const host = new URL(hfUrl).hostname.toLowerCase();
        if (host !== 'civitai.com' && host !== 'www.civitai.com') {
          resolvedFilename = hfUrl.split('/').pop();
        }
      } catch { /* bubble up below */ }
    }
    const id = { modelName, filename: resolvedFilename };
    const existing = findByIdentity(id);
    if (existing) { res.json({ success: true, taskId: existing.taskId, alreadyActive: true }); return; }
    const queued = findQueuedByIdentity(id);
    if (queued) { res.json({ success: true, taskId: queued.synthId, queued: true }); return; }
    if (isAtCapacity() && hfUrl && modelDir) {
      // Even when queued, populate the catalog row so the UI shows the
      // pending entry instead of nothing.
      if (resolvedFilename) prepopulateCatalog(resolvedFilename, modelDir, hfUrl, meta, modelName);
      const synthId = enqueueDownload({ hfUrl, modelDir, ...id });
      res.json({ success: true, taskId: synthId, queued: true });
      return;
    }
    if (!hfUrl || !modelDir) { res.status(400).json({ error: 'hfUrl and modelDir required' }); return; }

    const tokens = {
      hfToken: hfToken || settings.getHfToken(),
      civitaiToken: civitaiToken || settings.getCivitaiToken(),
    };
    const out = await models.downloadCustom(hfUrl, modelDir, tokens, resolvedFilename);
    // Populate AFTER the download service returns so `downloading: true` never
    // lands on a row whose task didn't actually start. Route-level dedup above
    // (findByIdentity/findQueuedByIdentity) handles the already-active case;
    // this guards future edge cases where downloadCustom rejects internally.
    // The BEFORE→AFTER window is ~10 ms — the async download continues past
    // the return — so the Models page's next poll still sees the row.
    if (resolvedFilename) prepopulateCatalog(resolvedFilename, modelDir, hfUrl, meta, modelName);
    trackDownload(out.taskId, { modelName: out.fileName, filename: out.fileName });
    res.json({ success: true, taskId: out.taskId, message: `Starting download: ${out.fileName} -> ${out.saveDir}` });
  } catch (err) { sendError(res, err, 500, 'Download failed'); }
};

// ---- Mount canonical + legacy aliases ----

router.get(['/models', '/launcher/models'], handleGetModels);
router.post(['/models/scan', '/launcher/models/scan'], handleScan);
router.post(['/models/delete', '/launcher/models/delete'], handleDelete);
router.post(['/models/cancel-download', '/launcher/models/cancel-download'], handleCancel);
router.post(['/models/install/:modelName', '/launcher/models/install/:modelName'], handleInstall);
router.get(['/models/progress/:id', '/launcher/models/progress/:id'], handleProgress);
router.get(['/models/download-history', '/launcher/models/download-history'], handleHistory);
router.post(['/models/download-history/clear', '/launcher/models/download-history/clear'], handleHistoryClear);
router.post(['/models/download-history/delete', '/launcher/models/download-history/delete'], handleHistoryDelete);
router.post(['/models/download-custom', '/launcher/models/download-custom'], downloadCustomLimiter, handleDownloadCustom);

const handleDownloadHfRepo: RequestHandler = async (req: Request, res: Response) => {
  try {
    const { hfRepo, directory, name, hfToken } = (req.body || {}) as {
      hfRepo?: string; directory?: string; name?: string; hfToken?: string;
    };
    if (!hfRepo || !/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(hfRepo)) {
      res.status(400).json({ error: 'hfRepo required (format "owner/repo")' });
      return;
    }
    if (!directory || directory.includes('..') || directory.startsWith('/')) {
      res.status(400).json({ error: 'directory required; must be relative without ".."' });
      return;
    }
    const out = await models.downloadHfRepo(
      hfRepo, directory, name || hfRepo,
      { hfToken: hfToken || settings.getHfToken() },
    );
    trackDownload(out.taskId, { modelName: out.modelName, filename: out.modelName });
    res.json({ success: true, taskId: out.taskId, modelName: out.modelName });
  } catch (err) { sendError(res, err, 500, 'HF repo download failed'); }
};

router.post(
  ['/models/download-hf-repo', '/launcher/models/download-hf-repo'],
  downloadCustomLimiter, handleDownloadHfRepo,
);

export default router;
