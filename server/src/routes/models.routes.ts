// Model management routes: scan, delete, cancel, install, download-custom,
// download-hf-repo, download-history, folders.

import { Router } from 'express';
import { z } from 'zod';
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
import {
  validateAllowedUrl, urlEncodesFilename,
} from '../services/models/downloadUrl.js';
import { paginate, splitPaginated } from '../lib/pagination.js';
import { markDownloadFailed } from '../services/catalog/index.js';
import * as catalog from '../services/catalog/index.js';
import { discoverHfSnapshotDirs, discoverAndUpsert } from '../services/models/discoverHfRepos.js';
import { formatBytes } from '../lib/format.js';
import { env } from '../config/env.js';
import { defineRoute } from '../lib/defineRoute.js';
import {
  NotFoundError, ValidationError,
} from '../lib/errors.js';
import {
  DownloadCustomBodySchema,
  modelsRoutes,
} from '../contracts/models.contract.js';

// 30 req/min per IP — download-custom triggers upstream HTTP fetches.
const downloadCustomLimiter = rateLimit('models:download-custom');

// ---- /models/folders ----

const FOLDERS_CACHE_TTL_MS = 60_000;
let foldersCache: { value: string[]; expiresAt: number } | null = null;

export function clearFoldersCache(): void {
  foldersCache = null;
}

export const foldersRoute = defineRoute(modelsRoutes.folders, async (ctx) => {
  const now = Date.now();
  if (foldersCache && foldersCache.expiresAt > now) return ctx.ok(foldersCache.value);
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
    return ctx.ok(names);
  } catch (err) {
    logger.warn('models folders fetch failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return ctx.ok([]);
  }
});

// ---- /models/scan ----

export const scanRoute = defineRoute(modelsRoutes.scan, async (ctx) => {
  const r = await models.scan();
  return ctx.ok({ success: true as const, count: r.count, models: r.models.map(toWireEntry) });
});

// ---- /models/rescan ----

export const rescanRoute = defineRoute(modelsRoutes.rescan, async (ctx) => {
  const refresh = await refreshModelListFromUpstream();
  if (!refresh.ok) {
    logger.warn('rescan: upstream fetch failed, continuing with existing cache', {
      reason: refresh.reason,
    });
  }
  invalidateModelListMemo();
  const result = await modelIndex.rebuildFullIndex();
  return ctx.ok({ ...result, modelListRefreshed: refresh.ok });
});

// ---- /models/delete ----

export const deleteModelRoute = defineRoute(modelsRoutes.deleteModel, async (ctx) => {
  const r = await models.deleteByName(ctx.body.modelName);
  if (!r.success) throw new ValidationError(r.message);
  return ctx.ok({ success: true as const, message: r.message });
});

// ---- /models/cancel-download ----

export const cancelDownloadRoute = defineRoute(modelsRoutes.cancelDownload, async (ctx) => {
  const { taskId, modelName } = ctx.body;
  const r = models.cancelDownload({ taskId, modelName });
  if (taskId) stopTracking(taskId);
  if (!r.success) throw new NotFoundError(r.message);
  return ctx.ok({ success: true as const, message: r.message });
});

// ---- /models/install/:modelName ----

export const installRoute = defineRoute(modelsRoutes.install, async (ctx) => {
  const { modelName } = ctx.params;
  const { source = 'hf' } = ctx.body;
  const existing = findByIdentity({ modelName });
  if (existing) {
    return ctx.ok({ success: true as const, taskId: existing.taskId, alreadyActive: true });
  }
  const hfToken = settings.getHfToken();
  try {
    const { taskId } = await models.installFromCatalog(modelName, source, hfToken);
    trackDownload(taskId, { modelName });
    return ctx.ok({ success: true as const, taskId, message: `Starting model download: ${modelName}` });
  } catch (err) {
    if (err instanceof NoDownloadSourceError) {
      throw new ValidationError(err.message);
    }
    throw err;
  }
});

// ---- /models/download-history ----

export const downloadHistoryRoute = defineRoute(modelsRoutes.downloadHistory, async (ctx) => {
  const { page, pageSize = 20 } = ctx.query;
  const history = [...listHistory()]
    .map(({ savePath: _drop, ...rest }) => rest)
    .sort((a, b) => (b.endTime ?? b.startTime ?? 0) - (a.endTime ?? a.startTime ?? 0));
  if (page === undefined) return ctx.ok(history);
  const { items, meta } = splitPaginated(paginate(history, page, pageSize));
  return ctx.ok(items, meta);
});

// ---- /models/download-history/clear ----

export const downloadHistoryClearRoute = defineRoute(modelsRoutes.downloadHistoryClear, (ctx) => {
  clearHistory();
  return ctx.ok({ success: true as const, message: 'History cleared' });
});

// ---- /models/download-history/delete ----

export const downloadHistoryDeleteRoute = defineRoute(modelsRoutes.downloadHistoryDelete, (ctx) => {
  const removed = deleteHistoryItem(ctx.body.id);
  if (!removed) throw new NotFoundError('History item not found');
  return ctx.ok({ success: true as const, message: `History item deleted: ${removed.modelName}` });
});

// ---- /models/download-custom ----

function prepopulateCatalog(
  filename: string,
  modelDir: string,
  hfUrl: string,
  meta: z.infer<typeof DownloadCustomBodySchema>['meta'] | undefined,
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
      error: undefined,
    });
  } catch {
    // best-effort; never block the download path
  }
}

export const downloadCustomRoute = defineRoute(modelsRoutes.downloadCustom, async (ctx) => {
  const { modelName, filename, hfUrl, modelDir, hfToken, civitaiToken, githubToken, meta } = ctx.body;

  if (hfUrl !== undefined) {
    const v = validateAllowedUrl(hfUrl);
    if (!v.ok) throw new ValidationError(v.error);
  }

  let resolvedFilename = filename;
  if (!resolvedFilename && hfUrl && urlEncodesFilename(hfUrl)) {
    resolvedFilename = hfUrl.split('/').pop();
  }

  const id = { modelName, filename: resolvedFilename };
  const existing = findByIdentity(id);
  if (existing) return ctx.ok({ success: true as const, taskId: existing.taskId, alreadyActive: true });
  const queued = findQueuedByIdentity(id);
  if (queued) return ctx.ok({ success: true as const, taskId: queued.synthId, queued: true });

  if (isAtCapacity() && hfUrl && modelDir) {
    if (resolvedFilename) prepopulateCatalog(resolvedFilename, modelDir, hfUrl, meta, modelName);
    const synthId = enqueueDownload({ hfUrl, modelDir, ...id });
    return ctx.ok({ success: true as const, taskId: synthId, queued: true });
  }

  if (!hfUrl || !modelDir) throw new ValidationError('hfUrl and modelDir required');

  const tokens = {
    hfToken: hfToken || settings.getHfToken(),
    civitaiToken: civitaiToken || settings.getCivitaiToken(),
    githubToken: githubToken || settings.getGithubToken(),
  };

  if (resolvedFilename) prepopulateCatalog(resolvedFilename, modelDir, hfUrl, meta, modelName);
  try {
    const out = await models.downloadCustom(hfUrl, modelDir, tokens, resolvedFilename);
    trackDownload(out.taskId, { modelName: out.fileName, filename: out.fileName });
    return ctx.ok({ success: true as const, taskId: out.taskId, message: `Starting download: ${out.fileName}` });
  } catch (err) {
    if (resolvedFilename) {
      try { markDownloadFailed(resolvedFilename, err instanceof Error ? err.message : String(err)); }
      catch { /* best effort cleanup */ }
    }
    throw err;
  }
});

// ---- /models/download-hf-repo ----

export const downloadHfRepoRoute = defineRoute(modelsRoutes.downloadHfRepo, async (ctx) => {
  const { hfRepo, directory, name, hfToken } = ctx.body;
  if (!/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(hfRepo)) {
    throw new ValidationError('hfRepo required (format "owner/repo")');
  }
  if (directory.includes('..') || directory.startsWith('/')) {
    throw new ValidationError('directory must be relative without ".."');
  }
  const out = await models.downloadHfRepo(
    hfRepo, directory, name || hfRepo,
    { hfToken: hfToken || settings.getHfToken() },
  );
  trackDownload(out.taskId, { modelName: out.modelName, filename: out.modelName });
  return ctx.ok({ success: true as const, taskId: out.taskId, modelName: out.modelName });
});

// ---- /models/discover-hf-repos (GET + POST) ----

export const discoverHfReposDryRoute = defineRoute(modelsRoutes.discoverHfReposGet, async (ctx) => {
  const found = await discoverHfSnapshotDirs();
  return ctx.ok({ success: true as const, found });
});

export const discoverHfReposMutateRoute = defineRoute(modelsRoutes.discoverHfReposPost, async (ctx) => {
  const result = await discoverAndUpsert();
  return ctx.ok({ success: true as const, ...result });
});

// ---- Router assembly ----

const router = Router();

foldersRoute.register(router);
scanRoute.register(router);
rescanRoute.register(router);
deleteModelRoute.register(router);
cancelDownloadRoute.register(router);
installRoute.register(router);
downloadHistoryRoute.register(router);
downloadHistoryClearRoute.register(router);
downloadHistoryDeleteRoute.register(router);
discoverHfReposDryRoute.register(router);
discoverHfReposMutateRoute.register(router);

// Rate-limited download routes on a sub-router.
const downloadRouter = Router();
downloadCustomRoute.register(downloadRouter);
downloadHfRepoRoute.register(downloadRouter);
router.use(downloadCustomLimiter, downloadRouter);

export default router;
