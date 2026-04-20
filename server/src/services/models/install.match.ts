// Match a catalog of models against a disk-scan result. Split out of
// `install.service.ts` for the 250-line cap.

import path from 'path';
import { logger } from '../../lib/logger.js';
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
  model.save_path = info.path;
  if (model.size) verifySizeMatch(model, info.size);
}

function verifySizeMatch(model: CatalogModelEntry, actualSize: number): void {
  if (!model.size) return;
  const expected = parseSizeString(model.size);
  if (!expected) return;
  if (Math.abs(actualSize - expected) / expected > 0.1) {
    model.fileStatus = 'incomplete';
    logger.warn('model size mismatch', {
      filename: model.filename,
      expected: model.size,
      actual: formatFileSize(actualSize),
    });
  }
}

export function parseSizeString(sizeStr: string): number | null {
  if (!sizeStr) return null;
  const match = sizeStr.match(/^([\d.]+)\s*([KMGT]B?)?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (isNaN(value)) return null;
  const unit = match[2]?.toUpperCase() || '';
  switch (unit) {
    case 'KB': case 'K': return value * 1024;
    case 'MB': case 'M': return value * 1024 * 1024;
    case 'GB': case 'G': return value * 1024 * 1024 * 1024;
    case 'TB': case 'T': return value * 1024 * 1024 * 1024 * 1024;
    default: return value;
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
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
