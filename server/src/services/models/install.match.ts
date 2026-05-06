// Match a catalog of models against a disk-scan result. Split out of
// `install.service.ts` for the 250-line cap.

import path from 'path';
import type { CatalogModelEntry } from './download.service.js';
import type { ScanInfo } from './install.scan.js';

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
  // 1) Exact save_path + filename match.
  if (model.filename && model.save_path) {
    const candidate = path.posix.join(model.save_path, model.filename);
    const info = installed.get(candidate);
    if (info && !claimed.has(candidate)) return { pathKey: candidate, info };
  }
  // 2) First unclaimed filename match.
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
