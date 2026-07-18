// Zod schemas for the song-library routes: GET/DELETE /api/ace/songs,
// GET /api/ace/songs/:id, PATCH /api/ace/songs/:id,
// POST /api/ace/songs/:id/favorite.
//
// Single-user: no `creator`/`is_public`/`like_count` fields — those were
// ace-step-ui's multi-tenant social layer. See migration 0005's header
// comment for the full rationale.

import { z } from 'zod';

export const SongSchema = z.object({
  id: z.string(),
  title: z.string(),
  lyrics: z.string().nullable(),
  style: z.string().nullable(),
  caption: z.string().nullable(),
  coverUrl: z.string().nullable(),
  audioUrl: z.string().nullable(),
  duration: z.number().nullable(),
  bpm: z.number().nullable(),
  keyScale: z.string().nullable(),
  timeSignature: z.string().nullable(),
  tags: z.array(z.string()),
  favorite: z.boolean(),
  generationParams: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Song = z.infer<typeof SongSchema>;

export const SongListQuerySchema = z.object({
  favorite: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const SongListResponseSchema = z.object({
  songs: z.array(SongSchema),
});

export const SongParamsSchema = z.object({
  id: z.string().min(1),
});

export const SongGetResponseSchema = z.object({
  song: SongSchema,
});

export const SongUpdateBodySchema = z.object({
  title: z.string().min(1).optional(),
  lyrics: z.string().nullable().optional(),
  style: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  coverUrl: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

export const SongFavoriteBodySchema = z.object({
  favorite: z.boolean(),
});

export const SongDeleteResponseSchema = z.object({
  success: z.boolean(),
});

// --- Playlists ---

export const PlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  coverUrl: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const PlaylistListResponseSchema = z.object({
  playlists: z.array(PlaylistSchema),
});

export const PlaylistCreateBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

export const PlaylistGetResponseSchema = z.object({
  playlist: PlaylistSchema,
  songs: z.array(SongSchema),
});

export const PlaylistParamsSchema = z.object({
  id: z.string().min(1),
});

export const PlaylistAddSongBodySchema = z.object({
  songId: z.string().min(1),
  position: z.number().int().nonnegative().optional(),
});

export const PlaylistSongParamsSchema = z.object({
  id: z.string().min(1),
  songId: z.string().min(1),
});
