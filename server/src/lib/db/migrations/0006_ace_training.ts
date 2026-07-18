// Schema v36 — ACE-Step training/LoRA/TTS/reference-track tables. Ported
// from ace-step-ui's `server/src/routes/{training,tts,referenceTrack}.ts` +
// `server/src/services/{stemJobs,ttsJobs}.ts`.
//
// ace-step-ui persists surprisingly little of this to a DB at all:
//   - Dataset contents + preprocess/auto-label/training progress live inside
//     the ACE-Step FastAPI process (dataset JSON on disk + in-memory task
//     state, polled via `/v1/dataset/*_status` and `/v1/training/status`).
//   - Stem-separation jobs (`stemJobs.ts`) and TTS jobs (`ttsJobs.ts`) are
//     plain in-memory `Map`s — job state (and its progress log) evaporates
//     on every Express restart, and the routes give the client no way to
//     recover a jobId once that happens.
//   - `reference_tracks` is the one real table (Postgres-style, `user_id`
//     scoped, via ace-step-ui's `db/pool.ts` shim).
//
// This port trades the in-memory maps for real tables — matching how
// `0005_ace_music.ts` persists `ace_generation_jobs` instead of ace-step-ui's
// equivalent in-memory generation queue — so a job survives a server
// restart enough to report its last-known status instead of 404ing outright.
// SINGLE-USER: `reference_tracks`' `user_id` scoping is dropped, same
// rationale as `0005_ace_music.ts`.
//
// Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are
// safe to re-run. No data loss on existing DBs. Follows the pattern of
// 0002_recipes.ts / 0005_ace_music.ts so connection.ts can call it from
// openAndInit.

import type Database from 'better-sqlite3';

/**
 * Apply the v36 ACE-Step training migration. Idempotent. Creates
 * `ace_training_datasets`, `ace_training_runs`, `ace_stem_jobs`,
 * `ace_tts_jobs`, and `ace_reference_tracks` if not already present.
 */
export function applyAceTrainingMigration(db: Database.Database): void {
  db.exec(`
    -- One row per dataset built/loaded via the training panel. The sample
    -- data itself lives in the dataset JSON at dataset_path (under
    -- paths.aceDatasetsDir) — this table is a lightweight index over those
    -- files so the settings (custom tag, tag position, ...) survive without
    -- re-parsing JSON, and so a future "recent datasets" list has something
    -- to query instead of a directory scan.
    CREATE TABLE IF NOT EXISTS ace_training_datasets (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL UNIQUE,
      dataset_path     TEXT NOT NULL,
      sample_count     INTEGER NOT NULL DEFAULT 0,
      custom_tag       TEXT,
      tag_position     TEXT,
      all_instrumental INTEGER NOT NULL DEFAULT 1,
      genre_ratio      REAL NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_training_datasets_updated ON ace_training_datasets(updated_at DESC);

    -- Persisted history of LoRA training runs. ACE-Step's FastAPI only
    -- tracks the CURRENTLY active run in memory ('/v1/training/status') with
    -- no history once it finishes or the process restarts; this table is
    -- comfy's own record of what was started, when, and with which
    -- hyperparameters, kept in sync by a background poll loop (see
    -- routes/ace/training.routes.ts) until the run reaches a terminal
    -- status. If the Express process itself restarts mid-run, the poll loop
    -- is lost and the row is left at 'running' — the training-status route
    -- always re-queries the FastAPI directly for the live truth, so this is
    -- a history/audit record, not the source of truth.
    CREATE TABLE IF NOT EXISTS ace_training_runs (
      id               TEXT PRIMARY KEY,
      dataset_name     TEXT,
      tensor_dir       TEXT,
      output_dir       TEXT NOT NULL,
      hyperparams_json TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'running',
      error            TEXT,
      started_at       INTEGER NOT NULL,
      finished_at      INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_training_runs_status  ON ace_training_runs(status);
    CREATE INDEX IF NOT EXISTS idx_ace_training_runs_created ON ace_training_runs(created_at DESC);

    -- Stem-separation (audio-separator CLI) jobs. Was ace-step-ui's
    -- in-memory stemJobs.ts Map; persisted here so a page reload /
    -- server restart doesn't strand the client with an unresolvable jobId.
    CREATE TABLE IF NOT EXISTS ace_stem_jobs (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'queued',
      progress    INTEGER NOT NULL DEFAULT 0,
      current_idx INTEGER NOT NULL DEFAULT 0,
      total       INTEGER NOT NULL DEFAULT 0,
      log_json    TEXT NOT NULL DEFAULT '[]',
      result_json TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_stem_jobs_updated ON ace_stem_jobs(updated_at DESC);

    -- Voice-clone TTS (IndexTTS2) jobs. Was ace-step-ui's in-memory
    -- ttsJobs.ts Map; persisted for the same reason as ace_stem_jobs.
    CREATE TABLE IF NOT EXISTS ace_tts_jobs (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'queued',
      progress    REAL NOT NULL DEFAULT 0,
      log_json    TEXT NOT NULL DEFAULT '[]',
      result_json TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_tts_jobs_updated ON ace_tts_jobs(updated_at DESC);

    -- User-uploaded reference audio (cover mode / audio2audio source, and
    -- TTS voice-clone reference clips), with optional Whisper-transcribed
    -- lyrics. Ported from ace-step-ui's Postgres-style reference_tracks
    -- (was user_id-scoped); single-user here, so user_id is dropped. The
    -- audio bytes themselves are written under paths.aceReferencesDir via
    -- services/ace/storage.ts, same as generate.routes.ts's uploaded
    -- reference/source audio — storage_key is that module's 'key'.
    CREATE TABLE IF NOT EXISTS ace_reference_tracks (
      id              TEXT PRIMARY KEY,
      filename        TEXT NOT NULL,
      storage_key     TEXT NOT NULL,
      duration        INTEGER,
      file_size_bytes INTEGER,
      lyrics          TEXT,
      tags_json       TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_reference_tracks_created ON ace_reference_tracks(created_at DESC);
  `);
}
