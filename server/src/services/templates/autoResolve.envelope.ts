// Shared helpers for converting a `ResolvedModel` (from HF/CivitAI/GitHub
// resolvers) into the staging-time `AutoResolvedModel` shape + persisting
// the same data into the local catalog. Pulled out of `autoResolveModels.ts`
// so that file stays under the 250-line per-file cap once Wave M added the
// gated/sizeBytes/bundled-fallback branches.

import * as catalog from '../catalog.js';
import { formatBytes } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import { folderForLoaderClass } from '../workflow/loaderFolders.js';
import type { ResolvedModel } from '../models/resolveHuggingface.js';
import type { AutoResolvedModel, AutoResolveSource } from './importStaging.js';

/** Build the shared `AutoResolvedModel` envelope the UI consumes. */
export function toAutoResolved(
  source: AutoResolveSource, resolved: ResolvedModel,
  loaderClass?: string, tooltipFolder?: string,
): AutoResolvedModel {
  const out: AutoResolvedModel = {
    source, downloadUrl: resolved.downloadUrl, confidence: 'high',
  };
  // Folder priority: tooltip-derived (plugin author authoritative) >
  // static loader-class map (ComfyUI-core convention) > URL guess. The
  // tooltip wins because plugin authors stamp the exact folder into
  // `/object_info` input descriptors via the
  // `'ComfyUI/models/<folder>' -folder` convention.
  const folder = tooltipFolder
    || folderForLoaderClass(loaderClass)
    || resolved.suggestedFolder;
  if (folder) out.suggestedFolder = folder;
  if (typeof resolved.sizeBytes === 'number') out.sizeBytes = resolved.sizeBytes;
  // Propagate gating so the review UI / catalog row can show the
  // "configure your token" prompt without a separate round trip.
  if (resolved.gated) {
    out.gated = true;
    if (resolved.gatedMessage) out.gatedMessage = resolved.gatedMessage;
  }
  return out;
}

/** Mirror auto-resolution into the local catalog so subsequent hits skip
 * the resolver. Best-effort: a write failure is logged but doesn't break
 * staging (read-only FS during tests etc.). */
export function upsertCatalogFromAuto(
  filename: string, resolved: ResolvedModel,
  loaderClass?: string, tooltipFolder?: string,
): void {
  const folder = tooltipFolder
    || folderForLoaderClass(loaderClass)
    || resolved.suggestedFolder
    || 'checkpoints';
  const sizeBytes = typeof resolved.sizeBytes === 'number' ? resolved.sizeBytes : undefined;
  try {
    catalog.upsertModel({
      filename,
      name: filename,
      type: folder,
      save_path: folder,
      url: resolved.downloadUrl,
      size_bytes: sizeBytes,
      size_pretty: typeof sizeBytes === 'number' ? formatBytes(sizeBytes) : undefined,
      size_fetched_at: typeof sizeBytes === 'number' ? new Date().toISOString() : null,
      source: `auto-resolve:${resolved.source}`,
      // Mirror gated state onto the row so subsequent visits (Models page,
      // refresh-size, dependency check) all agree on the auth requirement.
      gated: resolved.gated,
      gated_message: resolved.gatedMessage,
    });
  } catch (err) {
    logger.warn('autoResolveModels: catalog upsert failed', {
      filename, error: err instanceof Error ? err.message : String(err),
    });
  }
}
