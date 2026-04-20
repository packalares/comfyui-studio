// Model-resource installer. Resolves the target directory relative to the
// ComfyUI model tree, skips the download when an identical file already
// exists locally or on the shared hub, and otherwise delegates byte transfer
// to `baseInstaller.tryDownloadWithFallbacks`. Ports launcher's
// `resourcepacks/model-installer.ts`.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import {
  InstallStatus, type ModelResource,
} from '../../contracts/resourcePacks.contract.js';
import { resolveModelFilePath } from '../models/sharedModelHub.js';
import { collectModelDownloadUrls } from './downloadUrls.js';
import { tryDownloadWithFallbacks, type OnProgress } from './baseInstaller.js';

function modelsRoot(): string {
  return env.MODELS_DIR || path.join(env.COMFYUI_PATH, 'models');
}

function resolveOutput(resource: ModelResource): { dir: string; out: string } {
  const root = modelsRoot();
  const dir = safeResolve(root, resource.dir);
  const out = safeResolve(root, resource.dir, resource.out);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, out };
}

function skipIfExists(resource: ModelResource, onProgress: OnProgress): boolean {
  const existing = resolveModelFilePath(modelsRoot(), resource.dir, resource.out);
  if (!existing) return false;
  try {
    const st = fs.statSync(existing);
    if (st.size > 0) {
      logger.info('resource model already installed', { path: existing });
      onProgress(InstallStatus.SKIPPED, 100);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

export async function installModelResource(
  resource: ModelResource,
  _taskId: string,
  source: string,
  onProgress: OnProgress,
  abortController: AbortController,
): Promise<void> {
  if (skipIfExists(resource, onProgress)) return;
  const { out } = resolveOutput(resource);
  // Pre-flight: delete a zero-byte stale file.
  if (fs.existsSync(out)) {
    try {
      const st = fs.statSync(out);
      if (st.size <= 0) fs.unlinkSync(out);
    } catch { /* ignore */ }
  }
  const urls = collectModelDownloadUrls(resource.url, source);
  if (urls.length === 0) throw new Error(`No download URL for model ${resource.name}`);
  await tryDownloadWithFallbacks({
    outputPath: out,
    urls,
    abortController,
    onProgress,
    resourceName: resource.name,
    requireNonEmpty: true,
  });
}
