// Zod schemas for the ACE-Step reference-track routes:
// GET/POST /api/ace/reference-tracks, PATCH/DELETE /:id,
// POST /:id/transcribe. Ported from ace-step-ui's `server/src/routes/
// referenceTrack.ts` (Postgres-style, multi-user); single-user here, so
// there's no `user_id` on the wire shape.

import { z } from 'zod';

export const ReferenceTrackSchema = z.object({
  id: z.string(),
  filename: z.string(),
  audioUrl: z.string(),
  duration: z.number().nullable(),
  fileSizeBytes: z.number().nullable(),
  lyrics: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: z.number(),
});

export const ListReferenceTracksResponseSchema = z.object({
  tracks: z.array(ReferenceTrackSchema),
});

// POST / is multipart (spec registered for OpenAPI/audit only — see
// routes/ace/referenceTrack.routes.ts).
export const UploadReferenceTrackResponseSchema = z.object({
  track: ReferenceTrackSchema,
});

export const ReferenceTrackParamsSchema = z.object({
  id: z.string().min(1),
});

export const UpdateReferenceTrackBodySchema = z.object({
  duration: z.number().optional(),
  tags: z.array(z.string()).optional(),
});

export const UpdateReferenceTrackResponseSchema = z.object({
  track: ReferenceTrackSchema,
});

export const TranscribeReferenceTrackResponseSchema = z.object({
  lyrics: z.string(),
});

export const DeleteReferenceTrackResponseSchema = z.object({
  success: z.boolean(),
});
