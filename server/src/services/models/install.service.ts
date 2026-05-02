// Disk scan, install-status refresh, and delete.
//
// Responsibilities split across two helpers (scanFiles, matchInstalled) so
// the file stays below the 250-line cap.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import { inferModelType, getModelSaveDir } from './download.service.js';
import type { CatalogModelEntry } from './download.service.js';
import { inferType, type ScanInfo } from './install.scan.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import * as modelIndex from './modelIndex.js';
import { matchInstalled, parseSizeString, inferModelTypeFromPath, formatFileSize } from './install.match.js';

/**
 * Read every installed model out of the SQLite-backed index, returning a Map
 * keyed by `storePath` shape that matches the legacy walker contract:
 * `models/<topDir>/<rest>` for local rows, abs_path for hub rows. Downstream
 * (matchInstalled.applyMatch, resolveAbsoluteModelPath) joins COMFYUI_PATH
 * onto this key, so dropping the `models/` prefix breaks the delete path.
 */
export async function scanInstalledModels(): Promise<Map<string, ScanInfo>> {
  const result = new Map<string, ScanInfo>();
  try {
    await modelIndex.ensureFresh();
    const rows = modelFiles.listAll();
    for (const row of rows) {
      const key = row.root_kind === 'local'
        ? path.posix.join('models', row.rel_path)
        : row.abs_path;
      result.set(key, {
        path: key,
        filename: row.filename,
        size: row.size,
        status: row.status as ScanInfo['status'],
        type: inferType(row.rel_path),
      });
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
    // Notify readiness subscribers. Both the catalog filename and the
    // resolved display name are broadcast so template dep edges keyed on
    // either variant get flipped.
    const targetFilename = info.filename || modelName;
    bus.emit('model:removed', { filename: targetFilename, absPath: modelPath });
    if (info.name && info.name !== targetFilename) {
      bus.emit('model:removed', { filename: info.name, absPath: modelPath });
    }
    return { success: true, message: `Model ${modelName} deleted successfully` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('model delete failed', { message: msg });
    return { success: false, message: `Error deleting model: ${msg}` };
  }
}

function resolveAbsoluteModelPath(info: CatalogModelEntry, modelName: string): string {
  const filename = info.filename || modelName;
  // Index lookup is the authoritative source: it has the actual on-disk
  // path even when the catalog's `save_path` is a folder-only hint
  // (`detection`) or when the file lives in the shared hub mount.
  const indexed = modelFiles.listByFilename(filename)[0];
  if (indexed) return indexed.abs_path;
  // Fall back to deriving from catalog metadata for entries that haven't
  // been indexed yet. `save_path` here can be either an absolute path, a
  // legacy full-relative path (`models/<topdir>/<file>`), or a bare
  // folder name (`detection`); each gets joined onto the right base.
  if (info.save_path) {
    if (path.isAbsolute(info.save_path)) return info.save_path;
    if (info.save_path.startsWith('models/') || info.save_path.startsWith('models\\')) {
      return path.join(env.COMFYUI_PATH, info.save_path);
    }
    return path.join(env.COMFYUI_PATH, 'models', info.save_path, filename);
  }
  return path.join(
    env.COMFYUI_PATH,
    getModelSaveDir(info.type || inferModelType(filename)),
    filename,
  );
}

export { inferModelType, getModelSaveDir, formatFileSize, parseSizeString };
