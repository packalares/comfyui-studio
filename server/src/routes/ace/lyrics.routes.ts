// ACE-Step lyrics-generation route.
// POST /api/ace/lyrics/generate — generate lyrics from genre/topic/mood.  Scope: generate:write.
//
// Previously ran `data/ace/lyrics_generate.py` via llama-cpp-python (a
// CPU-only local GGUF model — a second LLM stack duplicating infrastructure
// comfy already has). Now delegates to Ollama via `services/ace/
// ollamaAssist.ts`, scheduled through the same `submitGpuJob('llm-chat', ...)`
// slot every other ollama consumer uses (routes/llm.routes.ts). The GGUF
// model catalog + `GET /ace/lyrics/models` listing route (never wired up for
// download in the first place — see the removed TODO) were retired
// alongside it; `data/ace/lyrics_generate.py` is left on disk, superseded,
// in case a future agent wants the reference implementation.

import { Router } from 'express';
import { defineRoute } from '../../lib/defineRoute.js';
import * as packModelsRepo from '../../lib/db/packModels.repo.js';
import { DEFAULT_LYRICS_SYSTEM_PROMPT } from '../../services/ace/prompts.js';
import { InternalError } from '../../lib/errors.js';
import { ollamaChat, resolveLyricsModel } from '../../services/ace/ollamaAssist.js';
import {
  LyricsGenerateBodySchema,
  LyricsGenerateResponseSchema,
} from '../../contracts/ace/lyrics.contract.js';

/** Effective lyrics system prompt: the `lyrics.systemPrompt` pack setting when
 *  an operator has customised it, else the shipped default. Read per-request
 *  (not cached) so an edit in Settings takes effect on the next generation
 *  without a restart. */
function lyricsSystemPrompt(): string {
  const custom = packModelsRepo.getSetting('ace-step', 'lyrics.systemPrompt');
  return custom && custom.trim() ? custom : DEFAULT_LYRICS_SYSTEM_PROMPT;
}

/**
 * Generate song lyrics via Ollama. Returns `null` (never throws) when no
 * ollama model is configured/installed or the completion otherwise fails —
 * callers (this file's route, `generate.routes.ts`'s Simple-mode
 * orchestration) degrade to no-lyrics rather than failing the whole request.
 * Exported so `routes/ace/generate.routes.ts` can reuse this instead of
 * re-implementing the ollama call.
 */
export async function generateLyrics(args: {
  genre?: string;
  language?: string;
  topic?: string;
  mood?: string;
  structure?: string;
  /** Explicit ollama model override — normally omitted; resolved from the
   *  `llm.lyricsModel` pack setting (falling back to the first installed
   *  ollama model) when absent. */
  modelId?: string;
}): Promise<string | null> {
  const model = args.modelId || await resolveLyricsModel();
  if (!model) return null;

  const parts: string[] = [];
  if (args.genre) parts.push(`Genre: ${args.genre}`);
  if (args.language) parts.push(`Language: ${args.language}`);
  if (args.mood) parts.push(`Mood: ${args.mood}`);
  if (args.topic) parts.push(`Topic: ${args.topic}`);
  if (args.structure) parts.push(`Structure: ${args.structure}`);
  const userPrompt = `Write song lyrics with the following specifications:\n${parts.join('\n')}`;

  return ollamaChat(model, lyricsSystemPrompt(), userPrompt, { temperature: 0.8, maxTokens: 1024 });
}

const generateRoute = defineRoute({
  method: 'POST',
  path: '/ace/lyrics/generate',
  body: LyricsGenerateBodySchema,
  response: LyricsGenerateResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Generate song lyrics from genre/topic/mood via Ollama',
}, async ({ body, ok }) => {
  const lyrics = await generateLyrics(body);
  if (!lyrics) {
    throw new InternalError(
      'Lyrics generation failed. No reachable Ollama model — pull one from Models → Ollama, '
      + 'or set one explicitly under this pack’s settings (llm.lyricsModel).',
    );
  }
  return ok({ lyrics });
});

const router = Router();
[generateRoute].forEach((r) => r.register(router));

export default router;
