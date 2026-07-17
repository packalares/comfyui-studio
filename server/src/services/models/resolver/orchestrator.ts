// Wave 8: 5-tier on-disk model presence resolver.
// Resolves model filenames referenced in a LiteGraph workflow to actual on-disk
// files indexed in the model_files DB. This is completely separate from
// autoResolveModels.ts, which resolves *download URLs* for missing models.

import * as modelFiles from '../../../lib/db/modelFiles.repo.js';
import { extractHashHints } from './extractHashHints.js';
import { disambiguate, type Candidate } from './sidecarDisambiguator.js';
import { applyResolutions, type ResolutionAction } from './rewriteWorkflow.js';

export interface ResolvedModel {
  filename: string;
  save_path: string;
  abs_path: string;
  /** Disk size in bytes, from the model_files index. */
  size?: number;
}

export interface ChooserCandidate {
  nodeId: string;
  widgetName: string;
  filename: string;
  candidates: Array<{ filename: string; save_path: string; abs_path: string; base_model?: string }>;
}

export interface OnDiskPresenceResult {
  /** Filename → resolved on-disk location. */
  resolutions: Map<string, ResolvedModel>;
  /** Filenames that could not be auto-resolved; user must choose. */
  chooserNeeded: ChooserCandidate[];
  /** Filenames with no on-disk match at all. */
  missing: string[];
  /** Workflow with resolved widget values substituted in (when any resolved). */
  rewrittenWorkflow: unknown;
}

function rowToCandidate(row: modelFiles.ModelFileRow): Candidate {
  return {
    filename: row.filename,
    save_path: row.top_dir,
    abs_path: row.abs_path,
    sha256: row.sha256 ?? undefined,
  };
}

/**
 * 5-tier on-disk presence resolution for a workflow.
 *
 * Tiers (first match wins):
 *   T1. SHA256 hash hint  → `listBySha256` → single result.
 *   T2. Exact (top_dir, filename) pair  → `findByDirAndName`.
 *   T3. Basename-exact  → `listByFilename` → single result.
 *   T4. Basename with sidecar disambiguation  → single result after filter.
 *   T5. Unresolvable  → chooserNeeded (multiple) or missing (zero).
 *
 * `chosenResolutions` (keyed by filename) lets callers short-circuit after
 * a previous round returned chooserNeeded.
 */
export async function resolveOnDiskPresence(
  workflow: unknown,
  chosenResolutions?: Record<string, { save_path: string; filename: string }>,
): Promise<OnDiskPresenceResult> {
  const hints = extractHashHints(workflow);
  const resolutions = new Map<string, ResolvedModel>();
  const chooserNeeded: ChooserCandidate[] = [];
  const missing: string[] = [];
  const actions: ResolutionAction[] = [];

  // Deduplicate hints by filename so we only resolve each filename once.
  const seen = new Set<string>();
  const uniqueHints = hints.filter((h) => {
    if (seen.has(h.filename)) return false;
    seen.add(h.filename);
    return true;
  });

  for (const hint of uniqueHints) {
    const { filename, nodeId, widgetName, sha256, baseModelHint } = hint;
    const basename = filename.includes('/')
      ? (filename.split('/').pop() ?? filename)
      : filename;
    const savePathHint = filename.includes('/')
      ? filename.slice(0, filename.lastIndexOf('/'))
      : '';

    // Caller-supplied resolution short-circuits all tiers.
    if (chosenResolutions?.[filename]) {
      const chosen = chosenResolutions[filename];
      resolutions.set(filename, {
        filename: chosen.filename,
        save_path: chosen.save_path,
        abs_path: '',
      });
      actions.push({
        nodeId,
        widgetName,
        originalValue: filename,
        resolvedSavePath: chosen.save_path,
        resolvedFilename: chosen.filename,
      });
      continue;
    }

    // T1: SHA256 hash hint.
    if (sha256) {
      const byHash = modelFiles.listBySha256(sha256);
      if (byHash.length === 1) {
        const r = byHash[0];
        resolutions.set(filename, { filename: r.filename, save_path: r.top_dir, abs_path: r.abs_path, size: r.size });
        actions.push({ nodeId, widgetName, originalValue: filename, resolvedSavePath: r.top_dir, resolvedFilename: r.filename });
        continue;
      }
    }

    // T2: Exact (top_dir, basename) pair when a save_path hint is present.
    if (savePathHint) {
      const exact = modelFiles.findByDirAndName(savePathHint, basename);
      if (exact && exact.status === 'complete') {
        resolutions.set(filename, { filename: exact.filename, save_path: exact.top_dir, abs_path: exact.abs_path, size: exact.size });
        actions.push({ nodeId, widgetName, originalValue: filename, resolvedSavePath: exact.top_dir, resolvedFilename: exact.filename });
        continue;
      }
    }

    // T3 + T4: Basename lookup.
    const rows = modelFiles.listByFilename(basename).filter((r) => r.status === 'complete');

    if (rows.length === 0) {
      missing.push(filename);
      continue;
    }

    if (rows.length === 1) {
      const r = rows[0];
      resolutions.set(filename, { filename: r.filename, save_path: r.top_dir, abs_path: r.abs_path, size: r.size });
      actions.push({ nodeId, widgetName, originalValue: filename, resolvedSavePath: r.top_dir, resolvedFilename: r.filename });
      continue;
    }

    // T4: Multiple candidates — try sidecar disambiguation.
    const { resolved, remaining } = disambiguate(
      rows.map(rowToCandidate),
      baseModelHint ?? null,
    );

    if (resolved) {
      // disambiguate returns Candidate (no size); look the size back up from the row.
      const row = rows.find((r) => r.abs_path === resolved.abs_path);
      resolutions.set(filename, { filename: resolved.filename, save_path: resolved.save_path, abs_path: resolved.abs_path, size: row?.size });
      actions.push({ nodeId, widgetName, originalValue: filename, resolvedSavePath: resolved.save_path, resolvedFilename: resolved.filename });
      continue;
    }

    // T5: Ambiguous — surface to caller.
    chooserNeeded.push({
      nodeId,
      widgetName,
      filename,
      candidates: remaining.map((c) => ({
        filename: c.filename,
        save_path: c.save_path,
        abs_path: c.abs_path,
        base_model: c.base_model,
      })),
    });
  }

  const rewrittenWorkflow = applyResolutions(workflow, actions);

  return { resolutions, chooserNeeded, missing, rewrittenWorkflow };
}
