// ACE-Step song-library routes. Ported from ace-step-ui's
// `server/src/routes/songs.ts`.
//
// Single-user simplification: ace-step-ui's version is a social feed
// (public/private visibility, likes, comments, follows, view counts,
// per-user ownership checks). None of that applies to a single-user local
// studio — this port is a straight local library: list/get/update/delete +
// a `favorite` pin, plus simple unordered playlists. Audio is served from
// `GET /api/ace/audio/output/:key` (minted by `services/ace/storage.ts`,
// registered in `routes/ace/generate.routes.ts`) — there is no separate
// per-song audio-proxy route here since the stored URL already points at it.
//
// Comments/likes/follows/public-discover feeds/stem extraction are NOT
// ported — see the migration 0005 header comment and this agent's final
// report for the full list of dropped ace-step-ui features.

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { defineRoute } from '../../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import * as aceMusicRepo from '../../lib/db/aceMusic.repo.js';
import * as storage from '../../services/ace/storage.js';
import {
  SongListQuerySchema,
  SongListResponseSchema,
  SongParamsSchema,
  SongGetResponseSchema,
  SongUpdateBodySchema,
  SongFavoriteBodySchema,
  SongDeleteResponseSchema,
  PlaylistListResponseSchema,
  PlaylistCreateBodySchema,
  PlaylistGetResponseSchema,
  PlaylistParamsSchema,
  PlaylistAddSongBodySchema,
  PlaylistSongParamsSchema,
} from '../../contracts/ace/songs.contract.js';

const router = Router();

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

const listRoute = defineRoute({
  method: 'GET',
  path: '/ace/songs',
  query: SongListQuerySchema,
  response: SongListResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
  tags: ['ace'],
  summary: 'List songs in the local library',
}, ({ query, ok }) => {
  const songs = aceMusicRepo.listSongs({
    favoriteOnly: query.favorite === 'true',
    limit: query.limit,
    offset: query.offset,
  });
  return ok({ songs });
});

const getRoute = defineRoute({
  method: 'GET',
  path: '/ace/songs/:id',
  params: SongParamsSchema,
  response: SongGetResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
  tags: ['ace'],
  summary: 'Get one song by id',
}, ({ params, ok }) => {
  const song = aceMusicRepo.getSong(params.id);
  if (!song) throw new NotFoundError('Song not found');
  return ok({ song });
});

const updateRoute = defineRoute({
  method: 'PATCH',
  path: '/ace/songs/:id',
  params: SongParamsSchema,
  body: SongUpdateBodySchema,
  response: SongGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['ace'],
  summary: 'Update song metadata (title, lyrics, style, caption, cover, tags)',
}, ({ params, body, ok }) => {
  if (!aceMusicRepo.getSong(params.id)) throw new NotFoundError('Song not found');
  const song = aceMusicRepo.updateSong(params.id, body);
  if (!song) throw new NotFoundError('Song not found');
  return ok({ song });
});

const favoriteRoute = defineRoute({
  method: 'POST',
  path: '/ace/songs/:id/favorite',
  params: SongParamsSchema,
  body: SongFavoriteBodySchema,
  response: SongGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['ace'],
  summary: 'Pin/unpin a song as favorite',
}, ({ params, body, ok }) => {
  if (!aceMusicRepo.getSong(params.id)) throw new NotFoundError('Song not found');
  const song = aceMusicRepo.setSongFavorite(params.id, body.favorite);
  if (!song) throw new NotFoundError('Song not found');
  return ok({ song });
});

const deleteRoute = defineRoute({
  method: 'DELETE',
  path: '/ace/songs/:id',
  params: SongParamsSchema,
  response: SongDeleteResponseSchema,
  auth: { required: true, scopes: ['gallery:delete'] },
  tags: ['ace'],
  summary: 'Delete a song (and its stored audio file, if any)',
}, async ({ params, ok }) => {
  const deleted = aceMusicRepo.deleteSong(params.id);
  if (!deleted) throw new NotFoundError('Song not found');
  if (deleted.audioUrl) {
    await storage.deleteAudioByUrl(deleted.audioUrl).catch(() => { /* best-effort */ });
  }
  if (deleted.coverUrl) {
    await storage.deleteAudioByUrl(deleted.coverUrl).catch(() => { /* best-effort */ });
  }
  return ok({ success: true });
});

// ---------------------------------------------------------------------------
// Playlists (local, unordered by user — simple id/name/description + members)
// ---------------------------------------------------------------------------

const playlistListRoute = defineRoute({
  method: 'GET',
  path: '/ace/playlists',
  response: PlaylistListResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
  tags: ['ace'],
  summary: 'List local playlists',
}, ({ ok }) => ok({ playlists: aceMusicRepo.listPlaylists() }));

const playlistCreateRoute = defineRoute({
  method: 'POST',
  path: '/ace/playlists',
  body: PlaylistCreateBodySchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['ace'],
  summary: 'Create a playlist',
}, ({ body, ok }) => {
  const playlist = aceMusicRepo.createPlaylist(randomUUID(), body.name, body.description ?? null);
  return ok({ playlist, songs: [] });
});

const playlistGetRoute = defineRoute({
  method: 'GET',
  path: '/ace/playlists/:id',
  params: PlaylistParamsSchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
  tags: ['ace'],
  summary: 'Get a playlist and its songs',
}, ({ params, ok }) => {
  const playlist = aceMusicRepo.getPlaylist(params.id);
  if (!playlist) throw new NotFoundError('Playlist not found');
  return ok({ playlist, songs: aceMusicRepo.listPlaylistSongs(params.id) });
});

const playlistDeleteRoute = defineRoute({
  method: 'DELETE',
  path: '/ace/playlists/:id',
  params: PlaylistParamsSchema,
  response: SongDeleteResponseSchema,
  auth: { required: true, scopes: ['gallery:delete'] },
  tags: ['ace'],
  summary: 'Delete a playlist (songs themselves are untouched)',
}, ({ params, ok }) => {
  const deleted = aceMusicRepo.deletePlaylist(params.id);
  if (!deleted) throw new NotFoundError('Playlist not found');
  return ok({ success: true });
});

const playlistAddSongRoute = defineRoute({
  method: 'POST',
  path: '/ace/playlists/:id/songs',
  params: PlaylistParamsSchema,
  body: PlaylistAddSongBodySchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['ace'],
  summary: 'Add a song to a playlist',
}, ({ params, body, ok }) => {
  const playlist = aceMusicRepo.getPlaylist(params.id);
  if (!playlist) throw new NotFoundError('Playlist not found');
  if (!aceMusicRepo.getSong(body.songId)) throw new ValidationError('Unknown songId');
  aceMusicRepo.addSongToPlaylist(params.id, body.songId, body.position ?? 0);
  return ok({ playlist, songs: aceMusicRepo.listPlaylistSongs(params.id) });
});

const playlistRemoveSongRoute = defineRoute({
  method: 'DELETE',
  path: '/ace/playlists/:id/songs/:songId',
  params: PlaylistSongParamsSchema,
  response: PlaylistGetResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['ace'],
  summary: 'Remove a song from a playlist',
}, ({ params, ok }) => {
  const playlist = aceMusicRepo.getPlaylist(params.id);
  if (!playlist) throw new NotFoundError('Playlist not found');
  aceMusicRepo.removeSongFromPlaylist(params.id, params.songId);
  return ok({ playlist, songs: aceMusicRepo.listPlaylistSongs(params.id) });
});

[
  listRoute, getRoute, updateRoute, favoriteRoute, deleteRoute,
  playlistListRoute, playlistCreateRoute, playlistGetRoute, playlistDeleteRoute,
  playlistAddSongRoute, playlistRemoveSongRoute,
].forEach((r) => r.register(router));

export default router;
