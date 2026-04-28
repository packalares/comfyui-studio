// Unified custom-download dispatcher.
//
// Accepts huggingface.co / hf-mirror.com / civitai.com / github.com release
// URLs, plus any allow-listed http(s) URL routed through the generic
// streamer. Dispatches auth + filename-parsing based on the host family.
//
// Civitai + generic downloads REQUIRE `filenameOverride` since their URL
// does not encode one. HF + GitHub release URLs can fall back to the URL's
// last path segment.
//
// Internally streams via `walker.walkAndDownload` so AUTH_REQUIRED stops
// the walk + URL_BROKEN falls through, matching the multi-mirror catalog
// path. For batch 1 we only ever hand a single candidate to the walker
// because the unified endpoint is single-URL by contract; the walker shape
// keeps the door open for the dependency-modal mirror walk.

import path from 'path';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import * as bus from '../../lib/events.js';
import {
  processHfEndpoint, validateHfUrl, validateCivitaiUrl,
  validateGithubUrl, validateGenericUrl,
  detectDownloadHost, buildResolveUrl, ensureSaveDirectory,
} from './download.service.js';
import { createDownloadTask, getTaskProgress } from '../downloadController/downloadController.service.js';
import { walkAndDownload } from '../downloadController/walker.js';
import { setModelMapping, getModelTaskId } from '../downloadController/progressTracker.js';
import { mergeUrlSources, urlSourceFor } from '../catalog.urlSources.js';
// Read directly from `catalogStore` (the persistent JSON store) instead of
// the higher-level `catalog.ts` to avoid pulling its `catalog.scan` import,
// which would re-import this file and form a cycle.
import { load as loadCatalogStore } from '../catalogStore.js';
import type { UrlSource } from '../../contracts/catalog.contract.js';

export interface DownloadCustomTokens {
  hfToken?: string;
  civitaiToken?: string;
  githubToken?: string;
}

export interface DownloadCustomResult {
  taskId: string;
  fileName: string;
  saveDir: string;
}

export async function downloadCustom(
  srcUrl: string,
  modelDir: string,
  tokens: DownloadCustomTokens,
  scanAndRefresh: () => Promise<unknown>,
  filenameOverride?: string,
): Promise<DownloadCustomResult> {
  if (!srcUrl) throw new Error('URL cannot be empty');
  if (!modelDir) throw new Error('Model directory cannot be empty');

  const { fileName, url } = resolveCustomUrl(srcUrl, filenameOverride);

  const existing = getModelTaskId(fileName);
  if (existing) return { taskId: existing, fileName, saveDir: modelDir };

  const taskId = createDownloadTask();
  setModelMapping(fileName, taskId);
  const saveDir = `models/${modelDir}`;
  ensureSaveDirectory(saveDir);
  const outputPath = path.join(env.COMFYUI_PATH, saveDir, fileName);
  logger.info('custom download starting', { url, path: outputPath });

  // History row is added by `downloadModelByName` inside the walker — adding
  // one here too created a dupe that was merged (by addHistoryItem's dedup)
  // under the FIRST row's id, leaving the SECOND row's id with nothing to
  // update on success. Keep this hands-off.
  const progress = getTaskProgress(taskId);
  if (progress) progress.abortController = new AbortController();

  // Walker candidates: start with the user-pasted URL (priority for the
  // Download dialog — they explicitly chose this source), then merge any
  // additional URLs the catalog already accumulated for this filename
  // (catalog seed + previous staging ops). `mergeUrlSources` dedups + sorts
  // by host priority, so the user URL still wins ties on its own host but
  // a higher-priority HF mirror added by staging will be tried first.
  const userCandidate = urlSourceFor(url, 'manual');
  const userOnly: UrlSource[] = userCandidate ? [userCandidate] : [];
  const row = loadCatalogStore().models.find((m) => m.filename === fileName);
  const candidates = row?.urlSources && row.urlSources.length > 0
    ? mergeUrlSources(userOnly, row.urlSources)
    : userOnly;

  void walkAndDownload({
    modelName: fileName,
    outputPath,
    taskId,
    candidates,
    tokens,
    source: 'custom',
  }).then(() => {
    bus.emit('model:installed', { filename: fileName });
    scanAndRefresh().catch(() => { /* best effort */ });
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('custom download failed', { message: msg });
    bus.emit('model:download-failed', { filename: fileName, error: msg });
  });
  return { taskId, fileName, saveDir };
}

/**
 * Resolve the user-supplied download URL into the actual streaming URL +
 * filename to use, dispatching by host family.
 */
export function resolveCustomUrl(
  srcUrl: string, filenameOverride?: string,
): { fileName: string; url: string } {
  const host = detectDownloadHost(srcUrl);
  if (host === 'huggingface') {
    const v = validateHfUrl(srcUrl);
    if (!v.isValid) throw new Error(v.error || 'Invalid URL');
    const fileName = pickFilename(filenameOverride, v.fileName);
    return { fileName, url: processHfEndpoint(buildResolveUrl(srcUrl)) };
  }
  if (host === 'civitai') {
    const v = validateCivitaiUrl(srcUrl);
    if (!v.isValid) throw new Error(v.error || 'Invalid URL');
    if (!filenameOverride || filenameOverride.trim().length === 0) {
      throw new Error('CivitAI downloads require an explicit filename (pass `filename` on the request body)');
    }
    return { fileName: filenameOverride, url: srcUrl };
  }
  if (host === 'github') {
    const v = validateGithubUrl(srcUrl);
    if (!v.isValid) throw new Error(v.error || 'Invalid URL');
    const fileName = pickFilename(filenameOverride, v.fileName);
    return { fileName, url: srcUrl };
  }
  if (host === 'generic') {
    const v = validateGenericUrl(srcUrl);
    if (!v.isValid) throw new Error(v.error || 'Invalid URL');
    if (!filenameOverride || filenameOverride.trim().length === 0) {
      // Generic hosts can't be assumed to encode a filename in their URL —
      // require the caller to be explicit so the engine writes the correct
      // file on disk. Same precedent as civitai.
      throw new Error('Generic-host downloads require an explicit filename (pass `filename` on the request body)');
    }
    return { fileName: filenameOverride, url: srcUrl };
  }
  throw new Error('Unsupported host: not on the download allow-list');
}

function pickFilename(override: string | undefined, fallback: string): string {
  if (override && override.trim().length > 0) return override;
  return fallback;
}
