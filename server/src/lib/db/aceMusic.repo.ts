// Repository for the ACE-Step music tables added in migration 0005
// (`ace_songs`, `ace_generation_jobs`, `ace_playlists`, `ace_playlist_songs`),
// reshaped by migration 0009 so `ace_songs` is a metadata sidecar of
// `gallery` rather than a parallel silo.
//
// `ace_songs` no longer stores `audio_url` / `duration` / `favorite` — those
// live exclusively on the joined `gallery` row (`gallery.url`,
// `gallery.mediaDurationMs`, `gallery.favorite`), reached via
// `ace_songs.gallery_id`. Every query below JOINs the two tables (INNER JOIN
// is safe: the FK is NOT NULL and `ON DELETE CASCADE` guarantees a song row
// never outlives its gallery row). The wire `SongRow` shape below is
// unchanged from before the reshape — `audioUrl`/`duration`/`favorite` are
// still plain fields on it, just sourced from the join instead of local
// columns — so API consumers (routes, UI) don't need to know the join
// happened.
//
// Favorite/delete are NOT done here — they mutate the `gallery` row (see
// `services/gallery/service.ts`'s `setFavorite`/`removeItem`, called from
// `routes/ace/songs.routes.ts`) so the cascade + single-source-of-truth
// invariant holds. This repo only ever writes `ace_songs`' own columns.
//
// Single-user: no `user_id` column, no ownership checks — every row belongs
// to the one implicit local owner. See the migration file's header comment
// for the full ace-step-ui -> comfy simplification rationale.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';
import * as galleryRepo from './gallery.repo.js';
import type { GalleryRow } from './gallery.repo.js';

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

export interface SongRow {
  id: string;
  /** FK to `gallery.id` — the media file's single source of truth. Not part
   *  of the historical wire shape; routes may surface it if a future UI
   *  needs it, but today's consumers resolve favorite/delete through the
   *  song id alone (see `routes/ace/songs.routes.ts`). */
  galleryId: string;
  title: string;
  lyrics: string | null;
  style: string | null;
  caption: string | null;
  coverUrl: string | null;
  audioUrl: string | null;
  duration: number | null;
  bpm: number | null;
  keyScale: string | null;
  timeSignature: string | null;
  tags: string[];
  favorite: boolean;
  generationParams: Record<string, unknown> | null;
  generationJobId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SongDbRow {
  id: string;
  gallery_id: string;
  title: string;
  lyrics: string | null;
  style: string | null;
  caption: string | null;
  cover_url: string | null;
  bpm: number | null;
  key_scale: string | null;
  time_signature: string | null;
  tags_json: string;
  generation_params_json: string | null;
  generation_job_id: string | null;
  created_at: number;
  updated_at: number;
  // Joined from `gallery` (aliased in SELECT — see SONG_SELECT below).
  gallery_url: string | null;
  gallery_media_duration_ms: number | null;
  gallery_favorite: number;
}

/** Every song query selects through this JOIN so the three gallery-owned
 *  fields (url/duration/favorite) are always sourced live rather than risking
 *  a stale copy. */
const SONG_SELECT = `
  SELECT
    s.id, s.gallery_id, s.title, s.lyrics, s.style, s.caption, s.cover_url,
    s.bpm, s.key_scale, s.time_signature, s.tags_json,
    s.generation_params_json, s.generation_job_id, s.created_at, s.updated_at,
    g.url AS gallery_url, g.mediaDurationMs AS gallery_media_duration_ms,
    g.favorite AS gallery_favorite
  FROM ace_songs s
  JOIN gallery g ON g.id = s.gallery_id
`;

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function rowToSong(r: SongDbRow): SongRow {
  return {
    id: r.id,
    galleryId: r.gallery_id,
    title: r.title,
    lyrics: r.lyrics,
    style: r.style,
    caption: r.caption,
    coverUrl: r.cover_url,
    audioUrl: r.gallery_url,
    // gallery.mediaDurationMs is milliseconds (ffprobe-measured, the actual
    // file's real duration); the wire `Song.duration` field is seconds
    // (matches ACE-Step's own `audio_duration` param and
    // `pages/music/format.ts`'s formatDuration). Round rather than floor so
    // e.g. 29.6s of real audio doesn't display as a suspicious "29".
    duration: r.gallery_media_duration_ms != null ? Math.round(r.gallery_media_duration_ms / 1000) : null,
    // Defensive coercion, not decoration: rows written before the "N/A" fix
    // hold the STRING "N/A" in this INTEGER column (SQLite is dynamically
    // typed and stored it verbatim). Returning that raw fails `SongSchema`
    // client-side — "Response envelope failed schema validation" — for the
    // whole song list, not just the offending row.
    bpm: typeof r.bpm === 'number' ? r.bpm : (Number.isFinite(Number(r.bpm)) && r.bpm !== null && r.bpm !== '' ? Number(r.bpm) : null),
    keyScale: r.key_scale,
    timeSignature: r.time_signature,
    tags: parseJsonArray(r.tags_json),
    favorite: r.gallery_favorite === 1,
    generationParams: parseJsonObject(r.generation_params_json),
    generationJobId: r.generation_job_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewSongInput {
  id: string;
  /** The gallery row to insert alongside this song, in the same transaction
   *  — see `services/gallery/service.ts` / `services/gallery/diskSweep.ts`
   *  for the field conventions a `GalleryRow` should follow (this repo just
   *  reuses `gallery.repo.ts`'s own insert path, it doesn't hand-roll the
   *  gallery INSERT). */
  galleryRow: GalleryRow;
  title: string;
  lyrics?: string | null;
  style?: string | null;
  caption?: string | null;
  coverUrl?: string | null;
  bpm?: number | null;
  keyScale?: string | null;
  timeSignature?: string | null;
  tags?: string[];
  generationParams?: Record<string, unknown> | null;
  generationJobId?: string | null;
}

/** Insert the gallery row and the `ace_songs` sidecar row in one transaction
 *  — a song never exists without its gallery row (and vice versa isn't
 *  possible either, since nothing else references `ace_songs`). */
export function insertSong(input: NewSongInput, db: Database.Database = getDb()): SongRow {
  const now = Date.now();
  const tx = db.transaction(() => {
    galleryRepo.insertGalleryRow(input.galleryRow, db);
    db.prepare(`
      INSERT INTO ace_songs
        (id, gallery_id, title, lyrics, style, caption, cover_url, bpm,
         key_scale, time_signature, tags_json, generation_params_json,
         generation_job_id, created_at, updated_at)
      VALUES
        (@id, @gallery_id, @title, @lyrics, @style, @caption, @cover_url, @bpm,
         @key_scale, @time_signature, @tags_json, @generation_params_json,
         @generation_job_id, @created_at, @updated_at)
    `).run({
      id: input.id,
      gallery_id: input.galleryRow.id,
      title: input.title,
      lyrics: input.lyrics ?? null,
      style: input.style ?? null,
      caption: input.caption ?? null,
      cover_url: input.coverUrl ?? null,
      bpm: input.bpm ?? null,
      key_scale: input.keyScale ?? null,
      time_signature: input.timeSignature ?? null,
      tags_json: JSON.stringify(input.tags ?? []),
      generation_params_json: input.generationParams ? JSON.stringify(input.generationParams) : null,
      generation_job_id: input.generationJobId ?? null,
      created_at: now,
      updated_at: now,
    });
  });
  tx();
  return getSong(input.id, db)!;
}

export function getSong(id: string, db: Database.Database = getDb()): SongRow | null {
  const row = db.prepare(`${SONG_SELECT} WHERE s.id = ?`).get(id) as SongDbRow | undefined;
  return row ? rowToSong(row) : null;
}

export interface SongListOptions {
  favoriteOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function listSongs(opts: SongListOptions = {}, db: Database.Database = getDb()): SongRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.favoriteOnly) clauses.push('g.favorite = 1');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 100;
  const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
  params.push(limit, offset);
  const rows = db.prepare(
    `${SONG_SELECT} ${where} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params) as SongDbRow[];
  return rows.map(rowToSong);
}

export interface SongUpdateInput {
  title?: string;
  lyrics?: string | null;
  style?: string | null;
  caption?: string | null;
  coverUrl?: string | null;
  tags?: string[];
}

/** Partial update — only columns present on `input` are written. */
export function updateSong(
  id: string,
  input: SongUpdateInput,
  db: Database.Database = getDb(),
): SongRow | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: Date.now() };
  if (input.title !== undefined) { sets.push('title = @title'); params.title = input.title; }
  if (input.lyrics !== undefined) { sets.push('lyrics = @lyrics'); params.lyrics = input.lyrics; }
  if (input.style !== undefined) { sets.push('style = @style'); params.style = input.style; }
  if (input.caption !== undefined) { sets.push('caption = @caption'); params.caption = input.caption; }
  if (input.coverUrl !== undefined) { sets.push('cover_url = @cover_url'); params.cover_url = input.coverUrl; }
  if (input.tags !== undefined) { sets.push('tags_json = @tags_json'); params.tags_json = JSON.stringify(input.tags); }
  if (sets.length === 0) return getSong(id, db);
  sets.push('updated_at = @updated_at');
  db.prepare(`UPDATE ace_songs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getSong(id, db);
}

// Favorite/delete are intentionally NOT repo functions here anymore — both
// now operate on the `gallery` row (`services/gallery/service.ts`'s
// `setFavorite`/`removeItem`), called directly from
// `routes/ace/songs.routes.ts`. Deleting the gallery row cascades to delete
// this sidecar row via the `gallery_id` FK's `ON DELETE CASCADE`.

// ---------------------------------------------------------------------------
// Generation jobs
// ---------------------------------------------------------------------------

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface GenerationJobRow {
  id: string;
  acestepTaskId: string | null;
  status: GenerationJobStatus;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface GenerationJobDbRow {
  id: string;
  acestep_task_id: string | null;
  status: GenerationJobStatus;
  params_json: string;
  result_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToJob(r: GenerationJobDbRow): GenerationJobRow {
  return {
    id: r.id,
    acestepTaskId: r.acestep_task_id,
    status: r.status,
    params: parseJsonObject(r.params_json) ?? {},
    result: parseJsonObject(r.result_json),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertGenerationJob(
  id: string,
  params: Record<string, unknown>,
  db: Database.Database = getDb(),
): GenerationJobRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO ace_generation_jobs (id, status, params_json, created_at, updated_at)
    VALUES (?, 'queued', ?, ?, ?)
  `).run(id, JSON.stringify(params), now, now);
  return getGenerationJob(id, db)!;
}

export function getGenerationJob(id: string, db: Database.Database = getDb()): GenerationJobRow | null {
  const row = db.prepare('SELECT * FROM ace_generation_jobs WHERE id = ?').get(id) as
    GenerationJobDbRow | undefined;
  return row ? rowToJob(row) : null;
}

export interface GenerationJobUpdateInput {
  acestepTaskId?: string | null;
  status?: GenerationJobStatus;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

export function updateGenerationJob(
  id: string,
  input: GenerationJobUpdateInput,
  db: Database.Database = getDb(),
): GenerationJobRow | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: Date.now() };
  if (input.acestepTaskId !== undefined) {
    sets.push('acestep_task_id = @acestep_task_id');
    params.acestep_task_id = input.acestepTaskId;
  }
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status; }
  if (input.result !== undefined) {
    sets.push('result_json = @result_json');
    params.result_json = input.result === null ? null : JSON.stringify(input.result);
  }
  if (input.error !== undefined) { sets.push('error = @error'); params.error = input.error; }
  if (sets.length === 0) return getGenerationJob(id, db);
  sets.push('updated_at = @updated_at');
  db.prepare(`UPDATE ace_generation_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getGenerationJob(id, db);
}

export function listGenerationJobs(limit = 50, db: Database.Database = getDb()): GenerationJobRow[] {
  const rows = db.prepare(
    'SELECT * FROM ace_generation_jobs ORDER BY created_at DESC LIMIT ?',
  ).all(Math.min(Math.max(limit, 1), 200)) as GenerationJobDbRow[];
  return rows.map(rowToJob);
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PlaylistDbRow {
  id: string;
  name: string;
  description: string | null;
  cover_url: string | null;
  created_at: number;
  updated_at: number;
}

function rowToPlaylist(r: PlaylistDbRow): PlaylistRow {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    coverUrl: r.cover_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createPlaylist(
  id: string,
  name: string,
  description: string | null,
  db: Database.Database = getDb(),
): PlaylistRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO ace_playlists (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, description, now, now);
  return getPlaylist(id, db)!;
}

export function getPlaylist(id: string, db: Database.Database = getDb()): PlaylistRow | null {
  const row = db.prepare('SELECT * FROM ace_playlists WHERE id = ?').get(id) as
    PlaylistDbRow | undefined;
  return row ? rowToPlaylist(row) : null;
}

export function listPlaylists(db: Database.Database = getDb()): PlaylistRow[] {
  const rows = db.prepare('SELECT * FROM ace_playlists ORDER BY created_at DESC').all() as
    PlaylistDbRow[];
  return rows.map(rowToPlaylist);
}

export function deletePlaylist(id: string, db: Database.Database = getDb()): boolean {
  const result = db.prepare('DELETE FROM ace_playlists WHERE id = ?').run(id);
  return result.changes > 0;
}

export function addSongToPlaylist(
  playlistId: string,
  songId: string,
  position: number,
  db: Database.Database = getDb(),
): void {
  db.prepare(`
    INSERT OR REPLACE INTO ace_playlist_songs (playlist_id, song_id, position, added_at)
    VALUES (?, ?, ?, ?)
  `).run(playlistId, songId, position, Date.now());
}

export function removeSongFromPlaylist(
  playlistId: string,
  songId: string,
  db: Database.Database = getDb(),
): void {
  db.prepare('DELETE FROM ace_playlist_songs WHERE playlist_id = ? AND song_id = ?')
    .run(playlistId, songId);
}

export function listPlaylistSongs(playlistId: string, db: Database.Database = getDb()): SongRow[] {
  const rows = db.prepare(`
    SELECT s.* FROM ace_playlist_songs ps
    JOIN ace_songs s ON s.id = ps.song_id
    WHERE ps.playlist_id = ?
    ORDER BY ps.position ASC
  `).all(playlistId) as SongDbRow[];
  return rows.map(rowToSong);
}
