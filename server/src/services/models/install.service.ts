// Disk scan, install-status refresh, and delete.
//
// Responsibilities split across two helpers (scanFiles, matchInstalled) so
// the file stays below the 250-line cap.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getExistingHubScanDirs } from './sharedModelHub.js';
import { inferModelType, getModelSaveDir } from './download.service.js';
import type { CatalogModelEntry } from './download.service.js';
import { scanDirectory, type ScanInfo } from './install.scan.js';
import { matchInstalled, parseSizeString, inferModelTypeFromPath, formatFileSize } from './install.match.js';

const SUBDIRS = [
  'checkpoints', 'loras', 'vae', 'controlnet', 'upscale_models', 'embeddings',
  'inpaint', 'diffusion_models', 'clip', 'clip_vision', 'hypernetworks',
  'ipadapter', 'unet', 'style_models', 'facerestore_models', 'text_encoders',
];

/** Walk the ComfyUI models tree + shared hub, return a Map keyed by storage path. */
export async function scanInstalledModels(): Promise<Map<string, ScanInfo>> {
  const result = new Map<string, ScanInfo>();
  const comfyuiPath = env.COMFYUI_PATH;
  try {
    const modelDirs = SUBDIRS.map((d) => path.join(comfyuiPath, 'models', d));
    // Shared hub is a read-only mount, never mkdir there. Ensure only local.
    for (const dir of modelDirs) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    }
    for (const dir of modelDirs) {
      await scanDirectory(dir, result, comfyuiPath);
    }
    for (const dir of getExistingHubScanDirs()) {
      await scanDirectory(dir, result, null);
    }
    logger.info('model scan completed', { count: result.size });
    return result;
  } catch (err) {
    logger.error('model scan failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
}

/**
 * Refresh install state on the given catalog, returning an updated list that
 * includes newly-discovered "unknown" models present on disk.
 */
export async function refreshInstalledStatus(
  models: CatalogModelEntry[],
): Promise<CatalogModelEntry[]> {
  try {
    const installed = await scanInstalledModels();
    const result = matchInstalled(models, installed);
    const unknown = gatherUnknownModels(installed, result.claimedPaths);
    if (unknown.length > 0) {
      logger.info('unknown models added from disk', { count: unknown.length });
      return [...result.models, ...unknown];
    }
    return result.models;
  } catch (err) {
    logger.error('refresh install status failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function gatherUnknownModels(
  installed: Map<string, ScanInfo>,
  claimed: Set<string>,
): CatalogModelEntry[] {
  const unknown: CatalogModelEntry[] = [];
  for (const [pathKey, info] of installed.entries()) {
    if (claimed.has(pathKey)) continue;
    unknown.push({
      name: info.filename || path.basename(pathKey),
      type: info.type || inferModelTypeFromPath(pathKey),
      base_url: '',
      save_path: pathKey,
      description: 'Locally discovered model, not in official list',
      filename: info.filename || path.basename(pathKey),
      installed: true,
      fileStatus: 'unknown',
      fileSize: info.size,
    });
  }
  return unknown;
}

/** Delete a model from disk. Searches through the supplied catalog for a match. */
export async function deleteModel(
  modelName: string,
  models: CatalogModelEntry[],
): Promise<{ success: boolean; message: string }> {
  try {
    const info = models.find((m) => m.name === modelName || m.filename === modelName);
    if (!info) return { success: false, message: `Model not found: ${modelName}` };
    if (!info.installed) return { success: false, message: `Model not installed: ${modelName}` };

    const modelPath = resolveAbsoluteModelPath(info, modelName);
    logger.info('attempting model delete', { modelName, path: modelPath });
    if (!fs.existsSync(modelPath)) {
      return { success: false, message: `Model file not found: ${modelPath}` };
    }
    fs.rmSync(modelPath, { force: true });
    logger.info('model deleted', { modelName });
    return { success: true, message: `Model ${modelName} deleted successfully` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('model delete failed', { message: msg });
    return { success: false, message: `Error deleting model: ${msg}` };
  }
}

function resolveAbsoluteModelPath(info: CatalogModelEntry, modelName: string): string {
  if (info.save_path) {
    return path.isAbsolute(info.save_path)
      ? info.save_path
      : path.join(env.COMFYUI_PATH, info.save_path);
  }
  return path.join(
    env.COMFYUI_PATH,
    getModelSaveDir(info.type || inferModelType(info.filename || modelName)),
    info.filename || modelName,
  );
}

export { inferModelType, getModelSaveDir, formatFileSize, parseSizeString };
