// Workflow-resource installer. Writes the downloaded workflow JSON into
// `<ComfyUI>/user/default/workflows/`. Ports launcher's
// `resourcepacks/workflow-installer.ts`.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { safeResolve } from '../../lib/fs.js';
import { InstallStatus, type WorkflowResource } from '../../contracts/resourcePacks.contract.js';
import { collectSimpleDownloadUrls } from './downloadUrls.js';
import { tryDownloadWithFallbacks, type OnProgress } from './baseInstaller.js';

function workflowsRoot(): string {
  return path.join(env.COMFYUI_PATH, 'user', 'default', 'workflows');
}

export async function installWorkflowResource(
  resource: WorkflowResource,
  _taskId: string,
  onProgress: OnProgress,
  abortController: AbortController,
): Promise<void> {
  const dir = workflowsRoot();
  fs.mkdirSync(dir, { recursive: true });
  const out = safeResolve(dir, resource.filename);
  const urls = collectSimpleDownloadUrls(resource.url);
  if (urls.length === 0) throw new Error(`No download URL for workflow ${resource.name}`);
  onProgress(InstallStatus.DOWNLOADING, 0);
  await tryDownloadWithFallbacks({
    outputPath: out,
    urls,
    abortController,
    onProgress,
    resourceName: resource.name,
    requireNonEmpty: false,
  });
}
