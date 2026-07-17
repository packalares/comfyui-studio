// Domain orchestrators: custom-URL download and whole-HF-repo download.
//
// Both hook into the same download-task + bus infrastructure so the progress
// UI and install-scan handlers work unchanged. `scanAndRefresh` is threaded
// in from models/service.ts to avoid a circular import.

import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import { logger } from '../../lib/logger.js';
import { safeResolve } from '../../lib/fs.js';
import { env, currentProcessEnv } from '../../config/env.js';
import * as bus from '../../lib/events.js';
import {
  processHfEndpoint, validateHfUrl, validateCivitaiUrl,
  validateGithubUrl, validateGenericUrl, normaliseGithubUrl,
  detectDownloadHost, buildResolveUrl, ensureSaveDirectory,
  composeModelSaveDir,
} from './downloadUrl.js';
import {
  createDownloadTask, getTaskProgress, updateTaskProgress,
  setModelMapping, getModelTaskId,
} from '../downloads/controller.js';
import { walkAndDownload } from '../downloads/walker.js';
import { mergeUrlSources, urlSourceFor } from '../catalog/urlSources.js';
// Read directly from the store layer to avoid pulling models/service.ts (cycle).
import { load as loadCatalogStore } from '../catalog/store.js';
import type { UrlSource } from '../../contracts/catalog.contract.js';
import { syncOne as syncIndexFile } from './modelIndex.js';
import { MODEL_EXTS } from './installScan.js';

// ── Custom-URL download ───────────────────────────────────────────────────────

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
  const saveDir = composeModelSaveDir(modelDir);
  ensureSaveDirectory(saveDir);
  const outputPath = path.join(env.COMFYUI_PATH, saveDir, fileName);
  logger.info('custom download starting', { url, path: outputPath });

  // History row is added by `downloadModelByName` inside the walker — adding
  // one here too would create a dupe. Keep this hands-off.
  const progress = getTaskProgress(taskId);
  if (progress) progress.abortController = new AbortController();

  // Walker candidates: start with the user-pasted URL (priority for the
  // Download dialog — they explicitly chose this source), then merge any
  // additional URLs the catalog already accumulated for this filename.
  // `mergeUrlSources` dedups + sorts by host priority, so the user URL still
  // wins ties on its own host but a higher-priority HF mirror added by staging
  // will be tried first.
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
    bus.emit('model:installed', { filename: fileName, absPath: outputPath });
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
 * filename, dispatching by host family.
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
    // Rewrite `github.com/.../raw/...` to `raw.githubusercontent.com/...`
    // so the streamer fetches the file directly without relying on the
    // 302 redirect chain (some clients drop auth headers across redirects).
    return { fileName, url: normaliseGithubUrl(srcUrl) };
  }
  if (host === 'generic') {
    const v = validateGenericUrl(srcUrl);
    if (!v.isValid) throw new Error(v.error || 'Invalid URL');
    if (!filenameOverride || filenameOverride.trim().length === 0) {
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

// ── HF-repo download ──────────────────────────────────────────────────────────

export interface HfRepoStartResult {
  taskId: string;
  modelName: string;
  saveDir: string;
}

/**
 * Kick off a `huggingface-cli download <hfRepo> --local-dir <directory>`
 * in the background. `directory` is relative to COMFYUI_PATH (NOT to
 * `models/`) — registry entries for custom nodes target
 * `custom_nodes/<plugin>/checkpoints` directly.
 */
export async function downloadHfRepo(
  hfRepo: string,
  directory: string,
  displayName: string,
  scanAndRefresh: () => Promise<unknown>,
  opts: { hfToken?: string } = {},
): Promise<HfRepoStartResult> {
  if (!hfRepo || !/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(hfRepo)) {
    throw new Error('Invalid hfRepo (expected "owner/repo")');
  }
  if (!directory || directory.includes('..') || directory.startsWith('/')) {
    throw new Error('Invalid directory (must be a relative path under COMFYUI_PATH)');
  }

  const modelName = displayName || hfRepo;
  const existing = getModelTaskId(modelName);
  if (existing) return { taskId: existing, modelName, saveDir: directory };

  const taskId = createDownloadTask();
  setModelMapping(modelName, taskId);
  // Auto-prepend `models/` for plain catalog save_paths so callers don't have
  // to remember the prefix. The previous behaviour landed snapshots at
  // `/root/ComfyUI/<save_path>/` instead of `/root/ComfyUI/models/<save_path>/`,
  // which is why captioner files were going to the wrong place. Custom-node
  // installs (`custom_nodes/<plugin>/checkpoints`) and explicit prefixes are
  // left alone.
  const safeDir = directory.startsWith('models/') || directory.startsWith('custom_nodes/')
    ? directory
    : `models/${directory}`;
  // safeResolve throws if safeDir (after path normalisation) escapes COMFYUI_PATH.
  const absDir = safeResolve(env.COMFYUI_PATH, safeDir);
  fs.mkdirSync(absDir, { recursive: true });

  updateTaskProgress(taskId, {
    status: 'downloading',
    startTime: Date.now(),
    abortController: new AbortController(),
  });
  logger.info('hf repo download starting', { hfRepo, absDir });

  const args = ['download', hfRepo, '--local-dir', absDir];
  const envVars: Record<string, string | undefined> = { ...currentProcessEnv() };
  if (opts.hfToken) envVars.HF_TOKEN = opts.hfToken;

  void runHfRepoCli(taskId, args, envVars).then(async () => {
    updateTaskProgress(taskId, {
      status: 'completed', completed: true, currentModelProgress: 100,
    });
    // Catalog listener marks the repo's catalog row installed off the
    // logical model name. The index needs per-file rows, so we walk the
    // target dir directly and sync each file — emitting per-file bus events
    // would duplicate-mark the catalog under filenames it doesn't carry.
    bus.emit('model:installed', { filename: modelName });
    await indexHfRepoFiles(absDir);
    scanAndRefresh().catch(() => { /* best effort */ });
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('hf repo download failed', { message: msg });
    updateTaskProgress(taskId, { status: 'error', error: msg });
    bus.emit('model:download-failed', { filename: modelName, error: msg });
  });

  return { taskId, modelName, saveDir: directory };
}

async function indexHfRepoFiles(absDir: string): Promise<void> {
  try {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      // Skip dot-directories (.cache, .git) to avoid following HF blob
      // symlinks that produce duplicate index entries (audit C6).
      if (e.name.startsWith('.')) continue;
      const full = path.join(absDir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await indexHfRepoFiles(full);
      } else if (e.isFile() && MODEL_EXTS.has(path.extname(e.name).toLowerCase())) {
        await syncIndexFile(full);
      }
    }
  } catch (err) {
    logger.warn('hf repo index walk failed', {
      absDir, error: err instanceof Error ? err.message : String(err),
    });
  }
}

function runHfRepoCli(
  taskId: string,
  args: string[],
  envVars: Record<string, string | undefined>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('huggingface-cli', args, { env: envVars as NodeJS.ProcessEnv });
    let lastStderrLine = '';
    proc.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        lastStderrLine = t;
        parseHfCliProgress(taskId, t);
      }
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`huggingface-cli exited ${code}: ${lastStderrLine}`));
    });
  });
}

/**
 * Parse tqdm-style progress from a single huggingface-cli stderr line and
 * mirror it onto the per-task tracker. Both `progress` (read by the
 * DependencyModal bar) and `currentModelProgress` (read by the batch
 * counter) are updated so the two UI surfaces stay in sync.
 */
function parseHfCliProgress(taskId: string, line: string): void {
  const pct = line.match(/(\d+(?:\.\d+)?)%/);
  if (pct) {
    const p = Number(pct[1]);
    if (Number.isFinite(p)) {
      updateTaskProgress(taskId, {
        currentModelProgress: p, overallProgress: p,
      });
    }
  }
  const bytes = line.match(/\b(\d+(?:\.\d+)?)(K|M|G|T)?B?\/(\d+(?:\.\d+)?)(K|M|G|T)?B?\b/);
  if (bytes) {
    const scale = (u?: string) => u === 'K' ? 1e3 : u === 'M' ? 1e6 : u === 'G' ? 1e9 : u === 'T' ? 1e12 : 1;
    const dl = Number(bytes[1]) * scale(bytes[2]);
    const tot = Number(bytes[3]) * scale(bytes[4]);
    if (Number.isFinite(dl) && Number.isFinite(tot) && tot > 0) {
      updateTaskProgress(taskId, { downloadedBytes: dl, totalBytes: tot });
    }
  }
}
