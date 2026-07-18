// Zod schemas for the ACE-Step voice-clone TTS routes:
// POST /api/ace/tts/clone (multipart; spec registered for OpenAPI/audit
// only — see routes/ace/tts.routes.ts), GET /api/ace/tts/status/:jobId.

import { z } from 'zod';

export const TtsCloneResponseSchema = z.object({
  jobId: z.string(),
});

export const TtsStatusParamsSchema = z.object({
  jobId: z.string().min(1),
});

export const TtsJobResultSchema = z.object({
  audioUrl: z.string(),
  durationSeconds: z.number(),
});

export const TtsStatusResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  progress: z.number(),
  log: z.array(z.string()),
  result: TtsJobResultSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
