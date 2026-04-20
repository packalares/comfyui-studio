// Plugin-resource installer. Delegates to the shared plugins install service
// rather than re-implementing git-clone + pip install. Ports launcher's
// `resourcepacks/plugin-installer.ts`.

import fs from 'fs';
import { randomUUID } from 'crypto';
import { logger } from '../../lib/logger.js';
import { InstallStatus, type PluginResource } from '../../contracts/resourcePacks.contract.js';
import { getPluginsRoot } from '../plugins/locations.js';
import { installPluginFromUrl } from '../plugins/install.service.js';
import { parseGithubOwnerRepo } from '../plugins/install.urlValidation.js';
import type { OnProgress } from './baseInstaller.js';

function pluginAlreadyInstalled(repo: string): boolean {
  const root = getPluginsRoot();
  if (!root) return false;
  try {
    if (!fs.existsSync(root)) return false;
    const items = fs.readdirSync(root);
    const lower = repo.toLowerCase();
    return items.some((name) => name.toLowerCase() === lower
      || name.toLowerCase() === `comfyui-${lower}`);
  } catch { return false; }
}

export async function installPluginResource(
  resource: PluginResource,
  _taskId: string,
  onProgress: OnProgress,
  abortController: AbortController,
): Promise<void> {
  onProgress(InstallStatus.INSTALLING, 0);
  const parsed = parseGithubOwnerRepo(resource.github);
  if (!parsed) throw new Error(`Invalid GitHub URL: ${resource.github}`);
  if (pluginAlreadyInstalled(parsed.repo)) {
    logger.info('plugin already installed, skipping', { repo: parsed.repo });
    onProgress(InstallStatus.SKIPPED, 100);
    return;
  }
  const operationId = randomUUID();
  const relay = (p: { progress: number; status: string; error?: string }): void => {
    if (abortController.signal.aborted) return;
    if (p.status === 'completed') onProgress(InstallStatus.COMPLETED, 100);
    else if (p.status === 'error') onProgress(InstallStatus.ERROR, 0, p.error);
    else onProgress(InstallStatus.INSTALLING, p.progress);
  };
  await installPluginFromUrl(resource.github, resource.branch, relay, operationId);
  onProgress(InstallStatus.COMPLETED, 100);
}
