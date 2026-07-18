// Zod schemas for the lyrics-generation routes: GET /api/ace/lyrics/models,
// POST /api/ace/lyrics/generate.
//
// Generation runs `data/ace/lyrics_generate.py` (llama-cpp-python, GGUF
// model) via `lib/exec.run` — CPU-only (`n_gpu_layers=0` hardcoded in the
// script), so these routes do NOT go through the GPU scheduler. See
// `routes/ace/lyrics.routes.ts` for the decision writeup.

import { z } from 'zod';

export const LyricsModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  size: z.string(),
  downloaded: z.boolean(),
});

export const LyricsModelsListResponseSchema = z.object({
  models: z.array(LyricsModelSchema),
});

export const LyricsGenerateBodySchema = z.object({
  genre: z.string().optional(),
  language: z.string().optional(),
  topic: z.string().optional(),
  mood: z.string().optional(),
  structure: z.string().optional(),
  modelId: z.string().optional(),
});

export const LyricsGenerateResponseSchema = z.object({
  lyrics: z.string(),
});
