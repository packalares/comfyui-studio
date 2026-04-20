// Custom-resource installer. Writes to an arbitrary destination path
// (relative paths resolved under ComfyUI root; absolute paths honoured).
// Every write is bounded by `safeResolve` so a traversal-prefixed
// destination cannot leak outside the resolved parent directory.
// Ports launcher's `resourcepacks/custom-installer.ts`.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import { InstallStatus, type CustomResource } from '../../contracts/resourcePacks.contract.js';
import { collectSimpleDownloadUrls } from './downloadUrls.js';
import { tryDownloadWithFallbacks, type OnProgress } from './baseInstaller.js';

function splitDestination(destination: string): { dir: string; filename: string } {
  if (path.isAbsolute(destination)) {
    return { dir: path.dirname(destination), filename: path.basename(destination) };
  }
  const joined = path.join(env.COMFYUI_PATH, destination);
  return { dir: path.dirname(joined), filename: path.basename(joined) };
}

export async function installCustomResource(
  resource: CustomResource,
  _taskId: string,
  onProgress: OnProgress,
  abortController: AbortController,
): Promise<void> {
  const { dir, filename } = splitDestination(resource.destination);
  fs.mkdirSync(dir, { recursive: true });
  const out = safeResolve(dir, filename);
  if (fs.existsSync(out)) {
    try {
      const st = fs.statSync(out);
      if (st.size > 0) {
        logger.info('resource custom already present', { path: out });
        onProgress(InstallStatus.SKIPPED, 100);
        return;
      }
      fs.unlinkSync(out);
    } catch { /* continue */ }
  }
  const urls = collectSimpleDownloadUrls(resource.url);
  if (urls.length === 0) throw new Error(`No download URL for custom resource ${resource.name}`);
  await tryDownloadWithFallbacks({
    outputPath: out,
    urls,
    abortController,
    onProgress,
    resourceName: resource.name,
    requireNonEmpty: true,
  });
}
