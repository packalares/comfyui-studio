// Schema v38 — per-pack model selection + settings state.
//
// Companion to `services/packs/registry.ts`'s new `PackModelDef` shape
// (id/repo/label/description/sizeGb/default/kind) and
// `services/packs/modelPaths.ts`'s destination resolver. The registry holds
// the DECLARATIVE catalog + defaults; these two tables hold only DEVIATIONS
// from that catalog, so a fresh DB (or a model with no row yet) always falls
// back to the registry's `default` cleanly — see `lib/db/packModels.repo.ts`.
//
// pack_models — one row per (pack, model) the user has ever touched
// (explicit select/deselect, repo override, or an actual download attempt).
//   selected      NULL = follow registry `default`; 0/1 = explicit user
//                 override. Deliberately its OWN column rather than folded
//                 into `state`: `state` tracks the download LIFECYCLE
//                 (absent/downloading/downloaded/failed), which is a
//                 different axis from "does the user want this on disk" —
//                 a model can be selected-but-not-yet-downloaded, which
//                 the 4-value state enum alone can't distinguish from
//                 "explicitly deselected".
//   state         'absent' (not on disk / explicitly removed) ->
//                 'downloading' -> 'downloaded' | 'failed'. Written by
//                 `services/packs/install.ts`, never by the settings PATCH.
//   repo_override NULL = use the registry's default `repo`. Set by
//                 `PATCH /packs/:id/settings` when the operator needs to
//                 correct a wrong HF repo id without a code change/redeploy
//                 (the exact production pain point this whole feature
//                 exists to fix — three wrong repo ids, three
//                 code-change -> sync -> retry cycles, in one night).
//   dest          Absolute destination directory recorded at
//                 download-start time (from `resolvePackModelDest`, itself
//                 derived from `kind` + effective repo). Recording it
//                 (rather than always recomputing) means a later registry
//                 change to the destination scheme can't strand an
//                 already-downloaded model's recorded location.
//   size_bytes    Best-effort on-disk size after a successful download —
//                 UI display only.
//   downloaded_at Epoch ms of the last successful download completion.
//
// pack_settings — generic per-pack-install key/value overrides, for
// settings that aren't a model selection (e.g. future pack-level toggles).
// Deliberately schemaless (TEXT value) rather than one column per setting,
// same reasoning `env-config.json` / other loosely-structured config in this
// codebase uses: new settings shouldn't need a migration to add.
//
// Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are
// safe to re-run. No data loss on existing DBs.

import type Database from 'better-sqlite3';

export function applyPackModelsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pack_models (
      pack_id       TEXT NOT NULL,
      model_id      TEXT NOT NULL,
      selected      INTEGER,
      state         TEXT NOT NULL DEFAULT 'absent',
      repo_override TEXT,
      dest          TEXT,
      size_bytes    INTEGER,
      downloaded_at INTEGER,
      PRIMARY KEY (pack_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pack_models_pack ON pack_models(pack_id);

    CREATE TABLE IF NOT EXISTS pack_settings (
      pack_id TEXT NOT NULL,
      key     TEXT NOT NULL,
      value   TEXT,
      PRIMARY KEY (pack_id, key)
    );
  `);
}
