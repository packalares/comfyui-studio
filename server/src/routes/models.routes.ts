// Model management routes. Backed by local services (ported from launcher's
// models + download + essential-models controllers). The /launcher/... aliases
// are preserved for studio's existing frontend; new canonical paths live at
// /api/models/... via the handlers below.

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

const handleHistory: RequestHandler = async (_req, res) => {
  try {
    const history = listHistory();
    res.json({ success: true, count: history.length, history });
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

const handleDownloadCustom: RequestHandler = async (req: Request, res: Response) => {
  try {
    const { modelName, filename, hfUrl, modelDir, hfToken } = (req.body || {}) as {
      modelName?: string; filename?: string; hfUrl?: string; modelDir?: string; hfToken?: string;
    };
    if (hfUrl !== undefined && !isHttpUrl(hfUrl)) { res.status(400).json({ error: 'hfUrl must be http(s)' }); return; }
    if (hfUrl !== undefined && hostIsPrivate(hfUrl)) { res.status(400).json({ error: 'hfUrl points at a private/loopback host' }); return; }
    const resolvedFilename = filename || hfUrl?.split('/').pop();
    const id = { modelName, filename: resolvedFilename };
    const existing = findByIdentity(id);
    if (existing) { res.json({ success: true, taskId: existing.taskId, alreadyActive: true }); return; }
    const queued = findQueuedByIdentity(id);
    if (queued) { res.json({ success: true, taskId: queued.synthId, queued: true }); return; }
    if (isAtCapacity() && hfUrl && modelDir) {
      const synthId = enqueueDownload({ hfUrl, modelDir, ...id });
      res.json({ success: true, taskId: synthId, queued: true });
      return;
    }
    if (!hfUrl || !modelDir) { res.status(400).json({ error: 'hfUrl and modelDir required' }); return; }
    const token = hfToken || settings.getHfToken();
    const out = await models.downloadCustom(hfUrl, modelDir, token);
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

export default router;
