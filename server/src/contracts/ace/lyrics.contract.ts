// Zod schemas for the lyrics-generation route: POST /api/ace/lyrics/generate.
//
// Generation is an Ollama chat completion (services/ace/ollamaAssist.ts),
// scheduled through the `llm-chat` GPU slot (services/gpu/scheduler.ts) —
// see `routes/ace/lyrics.routes.ts` for the decision writeup. The GGUF
// model-catalog schemas that used to live here (`LyricsModelSchema` /
// `LyricsModelsListResponseSchema`, for the retired llama-cpp-python path)
// were removed along with `GET /ace/lyrics/models`.

import { z } from 'zod';

export const LyricsGenerateBodySchema = z.object({
  genre: z.string().optional(),
  language: z.string().optional(),
  topic: z.string().optional(),
  mood: z.string().optional(),
  structure: z.string().optional(),
  /** Explicit Ollama model override. Normally omitted — resolved server-side
   *  from the `llm.lyricsModel` pack setting (falling back to the first
   *  installed Ollama model). */
  modelId: z.string().optional(),
});

export const LyricsGenerateResponseSchema = z.object({
  lyrics: z.string(),
});
