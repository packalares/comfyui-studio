// Schema v37 — image-LoRA training job table for the AI-Toolkit
// (ostris/ai-toolkit) capability pack.
//
// Unlike the ACE-Step training tables (`0006_ace_training.ts`), which mostly
// index state that actually lives inside a long-running FastAPI process,
// ai-toolkit training is a plain one-shot Python subprocess
// (`services/aiToolkit/train.ts` spawns `run.py <config>.yaml` directly) —
// this table IS the source of truth for job status/progress, not a cache
// over some other service's state. `config_json` stores the full resolved
// training request (base model, dataset, steps, lr, rank, alpha, resolution,
// trigger word, ...) so a job's exact parameters are always recoverable,
// even after the generated YAML file itself is cleaned up.
//
// SINGLE-USER: no `user_id` column — same rationale as every other table in
// this schema (see `0005_ace_music.ts` / `0006_ace_training.ts` header
// comments for the full write-up).
//
// Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are
// safe to re-run. No data loss on existing DBs.

import type Database from 'better-sqlite3';

/**
 * Apply the v37 AI-Toolkit training migration. Idempotent. Creates
 * `ai_toolkit_jobs` if not already present.
 */
export function applyAiToolkitMigration(db: Database.Database): void {
  db.exec(`
    -- One row per image-LoRA training run started from the Train LoRA page.
    -- status: 'queued' (accepted, waiting on the GPU scheduler slot) ->
    -- 'running' (run.py spawned) -> 'succeeded' | 'failed' | 'cancelled'.
    -- step/total_steps/progress are updated by parsing the trainer's tqdm
    -- progress-bar output (see services/aiToolkit/train.ts) — best-effort,
    -- not guaranteed to be exact for every ai-toolkit version.
    CREATE TABLE IF NOT EXISTS ai_toolkit_jobs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      base_model    TEXT NOT NULL,
      dataset_path  TEXT NOT NULL,
      config_json   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'queued',
      progress      REAL NOT NULL DEFAULT 0,
      step          INTEGER NOT NULL DEFAULT 0,
      total_steps   INTEGER NOT NULL DEFAULT 0,
      output_path   TEXT,
      error         TEXT,
      started_at    INTEGER,
      finished_at   INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_toolkit_jobs_status  ON ai_toolkit_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_ai_toolkit_jobs_created ON ai_toolkit_jobs(created_at DESC);
  `);
}
