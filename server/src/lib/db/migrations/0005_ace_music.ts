// Schema v35 — ACE-Step music generation tables: songs, generation jobs, and
// playlists. Ported from ace-step-ui's `server/src/db/migrate.ts`.
//
// SINGLE-USER SIMPLIFICATION: ace-step-ui is multi-tenant (every row FKs to
// `users(id)`, songs carry `is_public`/`like_count`/`view_count`, and there's
// a `comments`/`followers`/`liked_songs` social layer). Comfy Studio is
// single-user — this port drops `user_id` scoping entirely (no `users` table,
// no ownership FK, no auth-based access checks in the repo/routes layer) and
// drops the social features (comments, follows, likes, public/private
// visibility, featured/discover feeds) since they only make sense
// multi-tenant. What's kept:
//   - `ace_songs`      — the song library (was `songs`, minus social columns;
//                        `is_public`/`like_count`/`view_count` replaced by a
//                        single `favorite` flag for local pinning).
//   - `ace_generation_jobs` — async job tracking against the ACE-Step FastAPI
//                        task id (was `generation_jobs`, minus `user_id`).
//   - `ace_playlists` / `ace_playlist_songs` — user's local playlists (was
//                        `playlists`/`playlist_songs`, minus `user_id` and
//                        `is_public`).
// `reference_tracks`, `contact_submissions` were ace-step-ui SaaS-only
// concerns (multi-user upload quotas, a marketing contact form) and are not
// ported — reference/source audio for generation is handled by
// `services/ace/storage.ts` writing directly under `paths.aceReferencesDir`.
//
// Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are
// safe to re-run. No data loss on existing DBs. Follows the pattern of
// 0002_recipes.ts so connection.ts can call it from openAndInit.

import type Database from 'better-sqlite3';

/**
 * Apply the v35 ACE-Step music migration. Idempotent.
 * Creates `ace_songs`, `ace_generation_jobs`, `ace_playlists`, and
 * `ace_playlist_songs` if not already present.
 */
export function applyAceMusicMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ace_songs (
      id                 TEXT PRIMARY KEY,
      title              TEXT NOT NULL,
      lyrics             TEXT,
      style              TEXT,
      caption            TEXT,
      cover_url          TEXT,
      audio_url          TEXT,
      duration           INTEGER,
      bpm                INTEGER,
      key_scale          TEXT,
      time_signature     TEXT,
      tags_json          TEXT NOT NULL DEFAULT '[]',
      favorite           INTEGER NOT NULL DEFAULT 0,
      generation_params_json TEXT,
      generation_job_id  TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_songs_created_at ON ace_songs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ace_songs_favorite   ON ace_songs(favorite);

    CREATE TABLE IF NOT EXISTS ace_generation_jobs (
      id               TEXT PRIMARY KEY,
      acestep_task_id  TEXT,
      status           TEXT NOT NULL DEFAULT 'queued',
      params_json      TEXT NOT NULL,
      result_json      TEXT,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_generation_jobs_status     ON ace_generation_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_ace_generation_jobs_created_at ON ace_generation_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS ace_playlists (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      cover_url   TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ace_playlist_songs (
      playlist_id TEXT NOT NULL REFERENCES ace_playlists(id) ON DELETE CASCADE,
      song_id     TEXT NOT NULL REFERENCES ace_songs(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL DEFAULT 0,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, song_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ace_playlist_songs_playlist ON ace_playlist_songs(playlist_id);
  `);
}
