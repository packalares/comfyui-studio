// Disk scan, install-status refresh, match catalog vs disk.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import * as bus from '../../lib/events.js';
import { inferModelType, getModelSaveDir } from './downloadUrl.js';
import type { CatalogModelEntry } from './downloadUrl.js';
import * as modelFiles from '../../lib/db/modelFiles.repo.js';
import * as modelIndex from './modelIndex.js';
import {
  scanDirectory, type ScanInfo, inferType,
  resolveModelFilePath, getSharedModelHubRoot,
  COMFY_DIR_TO_HUB_SUBDIR, hubSubdirForComfyTopDir,
} from './installScan.js';

export { inferModelType, getModelSaveDir };
export type { CatalogModelEntry };

// Re-export hub resolver items consumed by info.ts and modelIndex.ts
export {
  resolveModelFilePath, getSharedModelHubRoot,
  COMFY_DIR_TO_HUB_SUBDIR, hubSubdirForComfyTopDir,
};

// Re-export scan primitives consumed externally (download.ts needs MODEL_EXTS)
export { MODEL_EXTS } from './installScan.js';

// ── Match catalog vs disk ─────────────────────────────────────────────────────

export interface MatchResult {
  models: CatalogModelEntry[];
  claimedPaths: Set<string>;
}

/**
 * For each catalog model find a best-fit disk entry. Multiple catalog aliases
 * for one filename can't all "claim" the same file, so we track claims in a
 * Set and fall back to unclaimed candidates.
 */
export function matchInstalled(
  models: CatalogModelEntry[],
  installed: Map<string, ScanInfo>,
): MatchResult {
  const byFilename = indexByFilename(installed);
  const claimedPaths = new Set<string>();
  const updated = models.map((m) => {
    const match = findMatch(m, installed, byFilename, claimedPaths);
    if (match) {
      claimedPaths.add(match.pathKey);
      applyMatch(m, match.info, match.pathKey);
    } else {
      m.installed = false;
      m.fileStatus = undefined;
    }
    return m;
  });
  return { models: updated, claimedPaths };
}

function indexByFilename(
  installed: Map<string, ScanInfo>,
): Map<string, Array<{ pathKey: string; info: ScanInfo }>> {
  const byFilename = new Map<string, Array<{ pathKey: string; info: ScanInfo }>>();
  for (const [pathKey, info] of installed.entries()) {
    const base = path.basename(pathKey);
    const arr = byFilename.get(base) || [];
    arr.push({ pathKey, info });
    byFilename.set(base, arr);
  }
  return byFilename;
}

function findMatch(
  model: CatalogModelEntry,
  installed: Map<string, ScanInfo>,
  byFilename: Map<string, Array<{ pathKey: string; info: ScanInfo }>>,
  claimed: Set<string>,
): { pathKey: string; info: ScanInfo } | null {
  // 1) Exact save_path + filename match. `scanInstalledModels` stores the
  // key with a leading `models/` prefix (see install.ts:151), while catalog
  // rows hold the bare folder name (`loras`, `checkpoints`, ...) — so we
  // try BOTH forms. Without this, every catalog row missed its scan entry,
  // the scan entry became a phantom "Locally discovered" duplicate, and
  // the Models UI rendered each model twice.
  if (model.filename && model.save_path) {
    const norm = model.save_path.replace(/^models\//, '');
    const stripped = path.posix.join(norm, model.filename);
    const withModels = path.posix.join('models', stripped);
    for (const candidate of [withModels, stripped]) {
      const info = installed.get(candidate);
      if (info && !claimed.has(candidate)) return { pathKey: candidate, info };
    }
    // Catalog declares a save_path: a same-named file in a different folder
    // is a DIFFERENT model. Don't fall through to the bare-filename match.
    return null;
  }
  // 2) First unclaimed filename match (only when catalog has no save_path).
  if (model.filename) {
    const candidates = byFilename.get(model.filename) || [];
    const unclaimed = candidates.find((c) => !claimed.has(c.pathKey));
    if (unclaimed) return unclaimed;
  }
  // 3) Substring match on name (legacy fallback).
  if (model.name) {
    for (const [pathKey, info] of installed.entries()) {
      if (claimed.has(pathKey)) continue;
      if (pathKey.includes(model.name)) return { pathKey, info };
    }
  }
  return null;
}

function applyMatch(
  model: CatalogModelEntry,
  info: ScanInfo,
  pathKey: string,
): void {
  model.installed = true;
  model.filename = info.filename || path.basename(pathKey);
  model.fileStatus = info.status;
  model.fileSize = info.size;
  // Preserve the catalog row's `save_path` — that's the folder name the
  // workflow / UI / dep-check expects (e.g. `detection`). Overwriting it
  // with the scan's full pathKey (`models/detection/yolov10m.onnx`)
  // breaks the badge in the Models page and confuses every consumer that
  // expects a bare folder. The actual file location is in the model_files
  // index; `resolveAbsoluteModelPath` looks it up there directly.
}

export function inferModelTypeFromPath(relativePath: string): string {
  const p = relativePath.toLowerCase();
  if (p.includes('checkpoints')) return 'checkpoint';
  if (p.includes('loras')) return 'lora';
  if (p.includes('vae')) return 'vae';
  if (p.includes('controlnet')) return 'controlnet';
  if (p.includes('upscale')) return 'upscaler';
  if (p.includes('embeddings')) return 'embedding';
  if (p.includes('inpaint')) return 'inpaint';
  return 'unknown';
}

// ── Install service ───────────────────────────────────────────────────────────

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
    // `pathKey` is `models/<dir>/<filename>` — extract just the bare folder
    // name so the wire shape matches the rest of the catalog (`loras`,
    // `checkpoints`, ...). Emitting the full path-with-filename as save_path
    // breaks the merge key in getMergedModels and rendered phantom dupes.
    const parentDir = path.posix.dirname(pathKey).replace(/^models\//, '');
    unknown.push({
      name: info.filename || path.basename(pathKey),
      type: info.type || inferModelTypeFromPath(pathKey),
      base_url: '',
      save_path: parentDir,
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

// Re-export scanDirectory for use by modelIndex (avoid duplicate code without
// creating a cycle — modelIndex.ts imports from installScan.ts directly now)
export { scanDirectory, type ScanInfo };
