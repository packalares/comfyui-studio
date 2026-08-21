// Schema v39 — `ace_songs` becomes a metadata sidecar to `gallery` instead of
// a parallel silo.
//
// Before this migration, generated song audio lived under
// `paths.aceAudioDir` (invisible to the gallery's disk-sweep and the
// operator's output backups) and every fact about a song — including ones
// the gallery already models (that a media file exists, its URL, its
// duration, its size, whether it's favorited) — lived in `ace_songs` alone.
// That's now backwards: `routes/ace/generate.routes.ts` writes generated
// audio into `paths.comfyOutputDir/ace-step/` and inserts a `gallery` row
// (mediaType:'audio') in the same transaction as the `ace_songs` row, so the
// gallery is the single source of truth that a song's media file exists.
//
// This migration:
//   - adds `ace_songs.gallery_id TEXT NOT NULL REFERENCES gallery(id)
//     ON DELETE CASCADE` — deleting the gallery row (favorite/delete now
//     both operate on `gallery`, see `routes/ace/songs.routes.ts`) cascades
//     to delete the sidecar row automatically.
//   - drops `audio_url`, `duration`, and `favorite` — the gallery now owns
//     all three (`gallery.url`, `gallery.mediaDurationMs`, `gallery.favorite`).
//     Critically, `favorite` must exist in exactly ONE place: before this
//     migration both tables had one and could disagree; only `gallery.favorite`
//     survives.
//   - keeps every music-only fact: lyrics, style, caption, cover_url, bpm,
//     key_scale, time_signature, tags, generation params/job id, and
//     playlist membership (`ace_playlist_songs`, unchanged — still FKs to
//     `ace_songs.id`).
//
// NO SONGS HAVE EVER BEEN GENERATED as of this migration (`ace_songs` is
// empty on every real deployment) — this is a clean schema change with no
// backfill to write. Rather than risk a silent data-loss bug on some future
// DB that DOES have rows, the migration asserts the table is empty before
// dropping it and throws loudly instead of proceeding if it isn't.
//
// `lib/db/aceMusic.repo.ts` reads `ace_songs` JOINed to `gallery` on
// `gallery_id`, so the wire `Song` shape (audioUrl/duration/favorite) is
// unchanged for API consumers — only where those three fields are stored
// changed.

import type Database from 'better-sqlite3';

export function applyAceSongsGalleryMigration(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(ace_songs)').all() as Array<{ name: string }>;
  const present = new Set(cols.map((c) => c.name));

  // Table doesn't exist yet (fresh DB, migration 0005 hasn't run before this
  // one in openAndInit — shouldn't happen given call order, but tolerate it:
  // the CREATE TABLE below will just create the new shape directly) OR it's
  // already been reshaped (has gallery_id) — either way, nothing to migrate.
  if (present.size > 0 && !present.has('gallery_id')) {
    const { c: count } = db.prepare('SELECT COUNT(*) as c FROM ace_songs').get() as { c: number };
    if (count > 0) {
      throw new Error(
        `Migration 0009 (ace_songs -> gallery sidecar) found ${count} existing row(s) in ` +
        '`ace_songs`, but this migration only knows how to reshape an EMPTY table (no songs ' +
        'had ever been generated when it was written, so no backfill path exists — old rows ' +
        'have no `gallery_id` to join against). Refusing to drop data. If you really do have ' +
        'songs to preserve, write a real backfill (mint a `gallery` row per existing ' +
        '`audio_url`/`duration`/`favorite` before dropping those columns) before upgrading.',
      );
    }
    db.exec('DROP TABLE ace_songs');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ace_songs (
      id                 TEXT PRIMARY KEY,
      gallery_id         TEXT NOT NULL REFERENCES gallery(id) ON DELETE CASCADE,
      title              TEXT NOT NULL,
      lyrics             TEXT,
      style              TEXT,
      caption            TEXT,
      cover_url          TEXT,
      bpm                INTEGER,
      key_scale          TEXT,
      time_signature     TEXT,
      tags_json          TEXT NOT NULL DEFAULT '[]',
      generation_params_json TEXT,
      generation_job_id  TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ace_songs_created_at ON ace_songs(created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ace_songs_gallery_id ON ace_songs(gallery_id);
  `);
}
