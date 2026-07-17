// Enrichment orchestrator.
//
// `enrichOne` resolves a model's abs_path, honors skip_metadata_refresh,
// computes SHA256 if missing, calls CivitAI by hash, merges into the sidecar
// preserving user fields (favorite, exclude, notes, usage_tips), writes back,
// and emits `model:enriched`.

import path from 'path';
import { env } from '../../../config/env.js';
import * as modelFiles from '../../../lib/db/modelFiles.repo.js';
import * as bus from '../../../lib/events.js';
import { logger } from '../../../lib/logger.js';
import { findRowFromStore } from '../../catalog/store.js';
import * as catalog from '../../catalog/service.js';
import { mergeUrlSources } from '../../catalog/urlSources.js';
import { formatBytes } from '../../../lib/format.js';
import { computeSha256 } from './hashCompute.js';
import { readSidecar, writeSidecar, sidecarExists, readClmSidecar, findExistingPreview } from './sidecar.js';
import { civitaiSource } from './CivitaiModelSource.js';
import { verifyUrlSources } from './verifyUrls.js';
import type { BaseModelMeta, ModelSourceResult } from './types.js';

export interface EnrichOneInput {
  save_path: string;
  filename: string;
  /** Force a specific source. Default 'auto' tries CivitAI only. */
  source?: 'auto' | 'civitai';
}

/**
 * Resolve the absolute on-disk path for a model, using the index first
 * (same strategy as `resolveAbsoluteModelPath` in install.ts — but we can't
 * import that without pulling in all of install.ts and its deps).
 */
function resolveAbsPath(save_path: string, filename: string): string | null {
  // Index lookup is authoritative.
  const rows = modelFiles.listByFilename(filename);
  if (rows.length > 0) {
    // Prefer the row whose rel_path matches our save_path.
    const match = rows.find((r) => r.rel_path === `${save_path}/${filename}`);
    return (match ?? rows[0]).abs_path;
  }
  // Fallback: derive from env.COMFYUI_PATH + save_path.
  if (!save_path || !filename) return null;
  return path.join(env.COMFYUI_PATH, 'models', save_path, filename);
}

/** User-owned fields that must survive a re-enrich. */
const USER_FIELDS = ['favorite', 'exclude', 'notes', 'usage_tips'] as const;
type UserField = typeof USER_FIELDS[number];

function mergeResult(
  existing: BaseModelMeta | null,
  fresh: Partial<BaseModelMeta>,
): BaseModelMeta {
  const base = {
    ...(existing ?? {}),
    ...fresh,
  } as BaseModelMeta;
  // Restore user fields from existing — never overwrite with upstream data.
  if (existing) {
    for (const field of USER_FIELDS) {
      const v = existing[field as UserField];
      if (v !== undefined) {
        (base as unknown as Record<string, unknown>)[field] = v;
      }
    }
  }
  return base;
}

/**
 * Enrich a single model:
 * 1. Resolve abs_path.
 * 2. Read existing sidecar; honor `skip_metadata_refresh`.
 * 3. Compute SHA256 if missing (and persist to DB).
 * 4. Call CivitAI by hash.
 * 5. Merge + write sidecar; preserve user fields.
 * 6. Upsert to catalog.json with CivitAI provenance.
 * 7. Verify urlSources hashes and persist verdicts to sidecar.
 * 8. Emit `model:enriched`.
 *
 * Returns the final sidecar meta, or null when the model file can't be found.
 */
export async function enrichOne(input: EnrichOneInput): Promise<BaseModelMeta | null> {
  const { save_path, filename } = input;
  const absPath = resolveAbsPath(save_path, filename);
  if (!absPath) {
    logger.warn('enrich: cannot resolve abs_path', { filename, save_path });
    return null;
  }

  // Read existing Studio sidecar. If none, fall back to CLM's sidecar so we
  // inherit their work (SHA256, tags, description, downloaded preview, etc.)
  // without ever overwriting their file.
  const existing = readSidecar(absPath)
    ?? readClmSidecar(absPath);

  // Honor skip_metadata_refresh.
  if (existing?.skip_metadata_refresh) {
    logger.info('enrich: skipping (skip_metadata_refresh=true)', { filename });
    return existing;
  }

  // Compute SHA256 if not yet in sidecar or DB.
  let sha256 = existing?.sha256;
  if (!sha256) {
    const dbRow = modelFiles.listByFilename(filename)
      .find((r) => r.abs_path === absPath);
    sha256 = dbRow?.sha256 ?? undefined;
  }
  if (!sha256) {
    try {
      sha256 = await computeSha256(absPath);
      // Persist to DB so the hash queue doesn't re-compute later.
      modelFiles.setSha256(absPath, sha256);
    } catch (err) {
      logger.warn('enrich: sha256 computation failed', {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Source lookup: CivitAI by hash only.
  let sourceResult: Partial<BaseModelMeta> = {};
  let found: ModelSourceResult | null = null;

  if (sha256) {
    found = await civitaiSource.searchByHash(sha256);
  }

  if (found) {
    sourceResult = {
      model_name: found.model_name,
      base_model: found.base_model,
      description: found.description,
      tags: found.tags,
      trigger_words: found.trigger_words,
      nsfw_level: found.nsfw_level,
      metadata_source: found.metadata_source,
      civitai_model_id: found.civitai_model_id,
      civitai_version_id: found.civitai_version_id,
      preview_remote_url: found.preview_remote_url,
      civitai_raw: found.civitai_raw,
      hf_repo: found.hf_repo,
    };
  } else {
    // CivitAI only — mark not found so we don't re-spam on next enrich.
    sourceResult = { civitai_deleted: true };
  }

  // Merge: upstream result on top of existing, but user fields from existing win.
  const freshFields: Partial<BaseModelMeta> = {
    ...sourceResult,
    filename,
    save_path,
    sha256_status: sha256 ? 'done' : ('error' as const),
    last_enriched_at: new Date().toISOString(),
  };
  if (sha256) freshFields.sha256 = sha256;
  // If a preview image is already on disk (CLM's .jpeg, our .preview.jpg,
  // etc.), point preview_local_path at it. Avoids redundant downloads and
  // keeps the catalog overlay accurate even when previewDownload hasn't run.
  // CRITICAL: also force-clear any stale preview_local_path inherited from
  // CLM (which may claim a file that doesn't actually exist on disk) — if
  // we leave a stale claim, the previewHook skips its download and the
  // thumbnail handler returns a placeholder.
  const existingPreview = findExistingPreview(absPath);
  freshFields.preview_local_path = existingPreview ?? undefined;
  const merged = mergeResult(existing, freshFields);
  // Belt + braces: scrub the merged result if the merge brought back a stale
  // path from `existing` after we explicitly set it to undefined above.
  if (merged.preview_local_path && !existingPreview) {
    delete merged.preview_local_path;
  }

  writeSidecar(absPath, merged);

  // After successful CivitAI enrichment, upsert to catalog.json so scan-only
  // rows get promoted to proper catalog entries with CivitAI provenance.
  if (found?.civitai_version_id) {
    try {
      const existingRow = findRowFromStore({ filename, save_path });
      const civitaiDownloadUrl = `https://civitai.com/api/download/models/${found.civitai_version_id}`;
      // Pull size from the model_files index so the catalog row isn't promoted
      // with `size_bytes: 0` (scan-only rows that never had a download URL
      // didn't have a known size either).
      const dbRow = modelFiles.listByFilename(filename)
        .find((r) => r.abs_path === absPath);
      const sizeBytes = dbRow?.size && dbRow.size > 0
        ? dbRow.size
        : existingRow?.size_bytes;
      catalog.upsertModel({
        filename,
        save_path,
        name: found.model_name ?? filename,
        type: existingRow?.type ?? 'other',
        url: civitaiDownloadUrl,
        urlSources: mergeUrlSources(existingRow?.urlSources, [{
          url: civitaiDownloadUrl,
          host: 'civitai',
          declaredBy: 'enrichment:civitai',
        }]),
        size_bytes: sizeBytes,
        size_pretty: sizeBytes ? formatBytes(sizeBytes) : existingRow?.size_pretty,
        source: 'enrichment:civitai',
      });
    } catch (err) {
      logger.warn('enrich: catalog upsert failed', {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Verify urlSources hashes and persist verdicts to sidecar.
  try {
    const catalogRow = findRowFromStore({ filename, save_path });
    const urlSrcs = catalogRow?.urlSources ?? [];
    if (urlSrcs.length > 0) {
      const verdicts = await verifyUrlSources(urlSrcs, sha256, found?.civitai_raw);
      merged.urlSources_verified = verdicts;
      writeSidecar(absPath, merged);
    }
  } catch (err) {
    logger.warn('enrich: verifyUrlSources failed', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  bus.emit('model:enriched', { filename, save_path, absPath });

  logger.info('enrich: done', {
    filename,
    source: merged.metadata_source ?? 'none',
    hasHash: !!sha256,
  });

  return merged;
}

// ---- Bulk enrichment loop ----

let enrichLoopRunning = false;

/** Pause between models so the CivitAI lookups don't hammer that API and
 *  the hash computation doesn't monopolise disk I/O during normal use. */
const INTER_MODEL_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start a background loop that enriches every installed model whose sidecar
 * doesn't exist yet. Each iteration calls `enrichOne` (which lazily computes
 * SHA256, looks up CivitAI, writes the sidecar, emits `model:enriched`).
 *
 * Idempotent — calling again while running is a no-op. Returns the count of
 * candidates queued *at start time* (synchronously); the actual loop runs
 * async and can be observed via the `model:enriched` event stream.
 */
export function startEnrichLoop(): { enqueued: number } {
  if (enrichLoopRunning) {
    return { enqueued: 0 };
  }
  const rows = modelFiles.listAll().filter((r) => r.status === 'complete');
  const candidates: Array<{ save_path: string; filename: string }> = [];
  for (const row of rows) {
    // Skip files that already have a sidecar — sidecarExists is a single fs.access.
    if (sidecarExists(row.abs_path)) continue;
    // rel_path is `<save_path>/<filename>` relative to the models/ root.
    const save_path = path.dirname(row.rel_path);
    candidates.push({ save_path, filename: row.filename });
  }
  if (candidates.length === 0) {
    return { enqueued: 0 };
  }
  enrichLoopRunning = true;
  void (async () => {
    logger.info('enrich-loop: started', { count: candidates.length });
    let done = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        await enrichOne(c);
        done++;
      } catch (err) {
        failed++;
        logger.warn('enrich-loop: enrichOne failed', {
          filename: c.filename,
          save_path: c.save_path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await sleep(INTER_MODEL_DELAY_MS);
    }
    enrichLoopRunning = false;
    logger.info('enrich-loop: finished', { done, failed });
  })();
  return { enqueued: candidates.length };
}

/** Exposed for tests / status endpoint. */
export function isEnrichLoopRunning(): boolean {
  return enrichLoopRunning;
}
