// Merges `registry.ts`'s static model catalog with `pack_models`/
// `pack_settings` DB deviations into the view `GET /packs/:id/settings`
// returns, and applies `PATCH /packs/:id/settings` edits back onto those
// tables. Kept separate from `install.ts` (which owns the actual
// download/venv orchestration) so the read/merge/patch logic has one home.

import * as packModelsRepo from '../../lib/db/packModels.repo.js';
import type { PackModelState } from '../../lib/db/packModels.repo.js';
import { getPack, type PackId, type PackSettingDef } from './registry.js';
import { resolvePackModelDest, looksDownloaded, type PackModelKind } from './modelPaths.js';

export interface PackModelSettingsView {
  id: string;
  label: string;
  description: string;
  kind: PackModelKind;
  sizeGb: number;
  /** Registry-declared default repo id. */
  defaultRepo: string;
  /** `repoOverride` if set, else `defaultRepo` — what an install actually uses. */
  effectiveRepo: string;
  repoOverride: string | null;
  /** Registry `default` flag — shown so the UI can label "(default)". */
  defaultSelected: boolean;
  /** `pack_models.selected` if set, else `defaultSelected`. */
  selected: boolean;
  state: PackModelState;
  /** Destination directory this model downloads into (recorded `dest` if a
   *  download has ever started, else the currently-resolved path). */
  dest: string;
  sizeBytes: number | null;
  downloadedAt: number | null;
}

export interface PackSettingsView {
  packId: PackId;
  models: PackModelSettingsView[];
  settings: Record<string, string>;
  /** Documented metadata for known `settings` keys — see registry.ts's
   *  `PackSettingDef`. A pack with no declared settings returns `[]`. */
  settingDefs: PackSettingDef[];
}

/** Effective repo id for a model: `repo_override` row value if present, else
 *  the registry default. Exported so `install.ts` shares this exact logic
 *  (a model must resolve to the same repo whether it's downloaded via the
 *  full pack install or the single-model download route). */
export function effectiveRepo(packId: PackId, modelId: string, registryRepo: string): string {
  const row = packModelsRepo.getModelRow(packId, modelId);
  return row?.repoOverride || registryRepo;
}

/** Effective selection for a model: explicit DB override if present, else
 *  the registry's `default` flag. */
export function isModelSelected(packId: PackId, modelId: string, registryDefault: boolean): boolean {
  const row = packModelsRepo.getModelRow(packId, modelId);
  if (!row || row.selected == null) return registryDefault;
  return row.selected;
}

/** Effective destination directory: the recorded `dest` from the last
 *  download attempt if present (stable even if the registry's derivation
 *  scheme changes later), else freshly resolved from `kind` + effective repo
 *  (+ `repoSubfolder`, for a model that's only one subfolder of a combined
 *  bundle repo — see `PackModelDef.repoSubfolder`). */
export function effectiveDest(
  packId: PackId,
  modelId: string,
  kind: PackModelKind,
  repo: string,
  repoSubfolder?: string,
): string {
  const row = packModelsRepo.getModelRow(packId, modelId);
  return row?.dest || resolvePackModelDest(kind, repo, repoSubfolder);
}

/**
 * Reconcile the RECORDED download state against what's actually on disk.
 *
 * `pack_models.state` is written only by the installer, so it describes "what
 * this server last did", not "what exists". Those diverge for real reasons:
 * an operator `mv`s weights in from another location or a previous install,
 * the DB is reset while the models volume persists, or (the case that
 * surfaced this) the destination scheme changes and the files are relocated
 * to match. In every one of those the UI claimed "not downloaded" over tens
 * of GB sitting right at `dest`, and the only offered action was to re-fetch
 * them.
 *
 * Same reasoning as `install.ts`'s venv guards: "the row says absent" is not
 * the same as "the disk is empty" — so trust the disk and heal the row.
 *
 * Only ever upgrades absent/failed/unrecorded -> downloaded. Deliberately
 * NOT the reverse: a `downloaded` row whose directory has gone missing is
 * left alone here, because that is a genuine problem (deleted/unmounted
 * volume) that should surface as a download failure with a real error rather
 * than be silently rewritten by a page load. `downloading` is never touched —
 * an in-flight install has a non-empty dest by definition.
 *
 * `sizeBytes` is intentionally left as-is rather than computed: sizing an
 * adopted tree means walking tens of GB, far too expensive for a GET, and
 * it's display-only. The next real download fills it in.
 */
function reconcileStateWithDisk(
  packId: PackId,
  modelId: string,
  recorded: PackModelState | undefined,
  dest: string,
): PackModelState {
  const current = recorded ?? 'absent';
  if (current === 'downloaded' || current === 'downloading') return current;
  if (!looksDownloaded(dest)) return current;
  // Persist so this survives as a real state transition (and so the installer
  // agrees with the UI), not a per-request illusion recomputed on every load.
  packModelsRepo.setState(packId, modelId, 'downloaded', { dest });
  return 'downloaded';
}

export function getPackSettingsView(packId: PackId): PackSettingsView {
  const pack = getPack(packId);
  if (!pack) throw new Error(`Unknown pack: ${packId}`);
  const rows = new Map(packModelsRepo.listModelRows(packId).map((r) => [r.modelId, r]));
  const models = pack.models.map((m): PackModelSettingsView => {
    const row = rows.get(m.id);
    const repo = row?.repoOverride || m.repo;
    const dest = row?.dest || resolvePackModelDest(m.kind, repo, m.repoSubfolder);
    const state = reconcileStateWithDisk(packId, m.id, row?.state, dest);
    return {
      id: m.id,
      label: m.label,
      description: m.description,
      kind: m.kind,
      sizeGb: m.sizeGb,
      defaultRepo: m.repo,
      effectiveRepo: repo,
      repoOverride: row?.repoOverride ?? null,
      defaultSelected: m.default,
      selected: row?.selected ?? m.default,
      state,
      dest,
      sizeBytes: row?.sizeBytes ?? null,
      downloadedAt: row?.downloadedAt ?? null,
    };
  });
  return {
    packId,
    models,
    settings: packModelsRepo.listSettings(packId),
    settingDefs: pack.settingDefs ?? [],
  };
}

export interface PackSettingsPatch {
  models?: Record<string, { selected?: boolean | null; repoOverride?: string | null }>;
  /** `null` value deletes the setting (resets to whatever code-level default
   *  the consumer applies). */
  settings?: Record<string, string | null>;
}

export function applyPackSettingsPatch(packId: PackId, patch: PackSettingsPatch): void {
  const pack = getPack(packId);
  if (!pack) throw new Error(`Unknown pack: ${packId}`);
  const modelIds = new Set(pack.models.map((m) => m.id));
  if (patch.models) {
    for (const [modelId, changes] of Object.entries(patch.models)) {
      if (!modelIds.has(modelId)) throw new Error(`Unknown model for pack ${packId}: ${modelId}`);
      if (Object.prototype.hasOwnProperty.call(changes, 'selected')) {
        packModelsRepo.setSelected(packId, modelId, changes.selected ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(changes, 'repoOverride')) {
        packModelsRepo.setRepoOverride(packId, modelId, changes.repoOverride ?? null);
      }
    }
  }
  if (patch.settings) {
    for (const [key, value] of Object.entries(patch.settings)) {
      if (value === null) packModelsRepo.deleteSetting(packId, key);
      else packModelsRepo.setSetting(packId, key, value);
    }
  }
}
