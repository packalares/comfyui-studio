// Whole-HuggingFace-repo downloader.
//
// Used by the custom-node registry path (IndexTTS2 etc.) where the model is
// a multi-file package and a single-URL download isn't enough. Hooks into the
// same download-task + bus infrastructure as `downloadCustom` so the existing
// progress UI and install-scan handlers work unchanged.

import path from 'path';
import { spawn } from 'child_process';
import { env, currentProcessEnv } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import {
  createDownloadTask, updateTaskProgress,
} from '../downloadController/downloadController.service.js';
import {
  setModelMapping, getModelTaskId,
} from '../downloadController/progressTracker.js';
import fs from 'fs';

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
 *
 * Caller is responsible for triggering a rescan after completion: this
 * function emits `model:installed` / `model:download-failed` like the
 * single-file downloader so the existing scan-and-refresh hook fires.
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
  const absDir = path.join(env.COMFYUI_PATH, directory);
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

  void runHfRepoCli(taskId, args, envVars).then(() => {
    updateTaskProgress(taskId, {
      status: 'completed', completed: true, currentModelProgress: 100,
    });
    bus.emit('model:installed', { filename: modelName });
    scanAndRefresh().catch(() => { /* best effort */ });
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('hf repo download failed', { message: msg });
    updateTaskProgress(taskId, { status: 'error', error: msg });
    bus.emit('model:download-failed', { filename: modelName, error: msg });
  });

  return { taskId, modelName, saveDir: directory };
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
