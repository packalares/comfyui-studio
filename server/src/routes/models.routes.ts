// Model management routes: scan, delete, cancel, install, download-custom,
// download-hf-repo, download-history, folders.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as models from '../services/models/service.js';
import { NoDownloadSourceError } from '../services/models/downloadUrl.js';
import * as modelIndex from '../services/models/modelIndex.js';
import { refreshModelListFromUpstream, invalidateModelListMemo } from '../services/models/info.js';
import { logger } from '../lib/logger.js';
import { toWireEntry } from '../services/models/service.js';
import * as settings from '../services/settings/index.js';
import {
  enqueueDownload, findByIdentity, findQueuedByIdentity, isAtCapacity,
  stopTracking, trackDownload,
} from '../services/downloads/index.js';
import {
  listHistory, clearHistory, deleteHistoryItem,
} from '../services/downloads/history.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';
import {
  validateAllowedUrl, urlEncodesFilename,
} from '../services/models/downloadUrl.js';
import { parsePageQuery, paginate } from '../lib/pagination.js';
import { markDownloadFailed } from '../services/catalog/index.js';
import * as catalog from '../services/catalog/index.js';
import { formatBytes } from '../lib/format.js';
import { env } from '../config/env.js';

const router = Router();

// 30 req/min per IP — download-custom triggers upstream HTTP fetches.
const downloadCustomLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// ---- /models/folders ----

const FOLDERS_CACHE_TTL_MS = 60_000;
let foldersCache: { value: string[]; expiresAt: number } | null = null;

export function clearFoldersCache(): void {
  foldersCache = null;
}

const handleFolders: RequestHandler = async (_req, res) => {
  const now = Date.now();
  if (foldersCache && foldersCache.expiresAt > now) {
    res.json(foldersCache.value);
    return;
  }
  try {
    const upstream = await fetch(`${env.COMFYUI_URL}/experiment/models`);
    if (!upstream.ok) throw new Error(`upstream status ${upstream.status}`);
    const raw = await upstream.json() as Array<{ name?: unknown }> | unknown;
    const list = Array.isArray(raw) ? raw : [];
    const names = list
      .map((row) => (row && typeof row === 'object' ? (row as { name?: unknown }).name : null))
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .sort((a, b) => a.localeCompare(b));
    foldersCache = { value: names, expiresAt: now + FOLDERS_CACHE_TTL_MS };
    res.json(names);
  } catch (err) {
    logger.warn('models folders fetch failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    res.json([]);
  }
};

// ---- download-custom helpers ----

/**
 * Optional metadata a client supplies at download start. Pre-populating the
 * catalog lets the Models page show a rich row + "Downloading…" badge
 * immediately instead of waiting for the disk scan.
 */
export interface DownloadCustomMeta {
  type?: string;
  description?: string;
  reference?: string;
  size_bytes?: number;
  thumbnail?: string;
  gated?: boolean;
  source?: string;
}

/**
 * Additive catalog pre-populate — existing `name`/`url`/etc. is preserved;
 * only new fields (thumbnail, downloading flag, error clear, size hint) are
 * merged in. Never throws — pre-populate is best-effort.
 */
function prepopulateCatalog(
  filename: string,
  modelDir: string,
  hfUrl: string,
  meta: DownloadCustomMeta | undefined,
  modelName: string | undefined,
): void {
  if (!filename) return;
  try {
    catalog.upsertModel({
      filename,
      name: modelName || filename,
      type: meta?.type || 'other',
      save_path: modelDir,
      url: hfUrl,
      description: meta?.description,
      reference: meta?.reference,
      thumbnail: meta?.thumbnail,
      gated: meta?.gated,
      size_bytes: meta?.size_bytes,
      size_pretty: meta?.size_bytes ? formatBytes(meta.size_bytes) : '',
      size_fetched_at: meta?.size_bytes ? new Date().toISOString() : null,
      source: meta?.source || 'user',
      downloading: true,
      // explicit undefined clears a prior error on retry
      error: undefined,
    });
  } catch {
    // best-effort; never block the download path
  }
}

// ---- Handlers ----

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
  } catch (err) {
    if (err instanceof NoDownloadSourceError) { res.status(400).json({ success: false, error: err.message, code: 'NO_DOWNLOAD_SOURCE' }); return; }
    sendError(res, err, 500, 'Install failed');
  }
};

const handleHistory: RequestHandler = async (req, res) => {
  try {
    // Sort newest-first so page 1 always shows active/recent downloads.
    // Strip `savePath` — absolute filesystem path the client doesn't need.
    const history = [...listHistory()]
      .map(({ savePath: _drop, ...rest }) => rest)
      .sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0));
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

const handleDownloadCustom: RequestHandler = async (req: Request, res: Response) => {
  try {
    const { modelName, filename, hfUrl, modelDir, hfToken, civitaiToken, githubToken, meta } = (req.body || {}) as {
      modelName?: string; filename?: string; hfUrl?: string; modelDir?: string;
      hfToken?: string; civitaiToken?: string; githubToken?: string;
      meta?: DownloadCustomMeta;
    };
    if (hfUrl !== undefined) {
      const v = validateAllowedUrl(hfUrl);
      if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    }
    // Resolve filename. HF/GitHub URLs encode it in the last path segment;
    // civitai `/api/download/models/:versionId` does NOT — caller must supply it.
    let resolvedFilename = filename;
    if (!resolvedFilename && hfUrl && urlEncodesFilename(hfUrl)) {
      resolvedFilename = hfUrl.split('/').pop();
    }
    const id = { modelName, filename: resolvedFilename };
    const existing = findByIdentity(id);
    if (existing) { res.json({ success: true, taskId: existing.taskId, alreadyActive: true }); return; }
    const queued = findQueuedByIdentity(id);
    if (queued) { res.json({ success: true, taskId: queued.synthId, queued: true }); return; }
    if (isAtCapacity() && hfUrl && modelDir) {
      // Pre-populate even when queued so the UI shows the pending entry.
      if (resolvedFilename) prepopulateCatalog(resolvedFilename, modelDir, hfUrl, meta, modelName);
      const synthId = enqueueDownload({ hfUrl, modelDir, ...id });
      res.json({ success: true, taskId: synthId, queued: true });
      return;
    }
    if (!hfUrl || !modelDir) { res.status(400).json({ error: 'hfUrl and modelDir required' }); return; }

    const tokens = {
      hfToken: hfToken || settings.getHfToken(),
      civitaiToken: civitaiToken || settings.getCivitaiToken(),
      githubToken: githubToken || settings.getGithubToken(),
    };
    // Prepopulate FIRST so the catalog row exists before the async download
    // fires `model:installed`. Tiny files can finish in <100ms; pre-populate
    // prevents a stuck `downloading:true` row when the completion event hits
    // a missing row and silently no-ops.
    if (resolvedFilename) prepopulateCatalog(resolvedFilename, modelDir, hfUrl, meta, modelName);
    try {
      const out = await models.downloadCustom(hfUrl, modelDir, tokens, resolvedFilename);
      trackDownload(out.taskId, { modelName: out.fileName, filename: out.fileName });
      res.json({ success: true, taskId: out.taskId, message: `Starting download: ${out.fileName}` });
    } catch (err) {
      if (resolvedFilename) {
        try { markDownloadFailed(resolvedFilename, err instanceof Error ? err.message : String(err)); }
        catch { /* best effort cleanup */ }
      }
      throw err;
    }
  } catch (err) { sendError(res, err, 500, 'Download failed'); }
};

const handleRescan: RequestHandler = async (_req, res) => {
  try {
    const refresh = await refreshModelListFromUpstream();
    if (!refresh.ok) {
      logger.warn('rescan: upstream fetch failed, continuing with existing cache', {
        reason: refresh.reason,
      });
    }
    invalidateModelListMemo();
    const result = await modelIndex.rebuildFullIndex();
    res.json({ ...result, modelListRefreshed: refresh.ok });
  } catch (err) { sendError(res, err, 500, 'Rescan failed'); }
};

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

// ---- Routes ----

router.get('/models/folders', handleFolders);
router.post('/models/rescan', handleRescan);
router.post('/models/scan', handleScan);
router.post('/models/delete', handleDelete);
router.post('/models/cancel-download', handleCancel);
router.post('/models/install/:modelName', handleInstall);
router.get('/models/download-history', handleHistory);
router.post('/models/download-history/clear', handleHistoryClear);
router.post('/models/download-history/delete', handleHistoryDelete);
router.post('/models/download-custom', downloadCustomLimiter, handleDownloadCustom);
router.post('/models/download-hf-repo', downloadCustomLimiter, handleDownloadHfRepo);

export default router;
