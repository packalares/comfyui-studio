// Internal Ollama chat-completion helper for ACE-Step's lyrics generation and
// prompt-suggestion features (routes/ace/lyrics.routes.ts, routes/ace/
// generate.routes.ts's `random-description` route).
//
// Previously, lyrics generation shelled out to `data/ace/lyrics_generate.py`
// (llama-cpp-python, a CPU-only local GGUF model) — a second LLM stack that
// duplicated infrastructure comfy already runs (ollama, wired up in
// `routes/llm.routes.ts`). This module replaces that with a direct call to
// Ollama's own `/api/chat`, going through the SAME `submitGpuJob('llm-chat',
// ...)` scheduler slot every other ollama consumer uses (see
// `services/gpu/scheduler.ts` / `services/gpu/taskTypes.ts`) so lyrics/
// suggestion generation queues fairly against chat instead of stealing the
// GPU out from under ACE-Step/ComfyUI/chat. It calls Ollama directly rather
// than looping back through our own `/api/llm/chat` HTTP route — that would
// be a pointless self-hop through the same process.
//
// Model selection: two independent `pack_settings` keys on the `ace-step`
// pack (services/packs/settings.ts + lib/db/packModels.repo.ts) —
// `llm.suggestionModel` (fast/small, one-line prompt ideas) and
// `llm.lyricsModel` (larger/stronger, full lyrics). Both are optional; when
// unset (or the configured model is no longer installed) this falls back to
// the first model Ollama reports installed. When ollama has NO models
// installed at all, callers get `null` and degrade locally (see
// `routes/ace/lyrics.routes.ts` / `routes/ace/generate.routes.ts`'s
// `FALLBACK_SAMPLES`) — ACE-Step itself is never started just to fill a text
// box or write a verse.

import { getOllamaUrl } from '../settings/index.js';
import { submitGpuJob } from '../gpu/scheduler.js';
import * as packModelsRepo from '../../lib/db/packModels.repo.js';
import { logger } from '../../lib/logger.js';

const PACK_ID = 'ace-step';

/** `pack_settings` key: fast/small model for one-line Simple-mode prompt
 *  suggestions (`GET /ace/generate/random-description`). */
export const SUGGESTION_MODEL_SETTING = 'llm.suggestionModel';
/** `pack_settings` key: larger/stronger model for full lyrics generation
 *  (`generateLyrics`, `POST /ace/lyrics/generate`). */
export const LYRICS_MODEL_SETTING = 'llm.lyricsModel';

interface OllamaTagsModel {
  name?: string;
}

/**
 * List installed Ollama model names (`GET /api/tags`). Best-effort — never
 * throws, returns `[]` on any failure so callers degrade to "no ollama
 * available" instead of surfacing a raw fetch error. NOT wrapped in
 * `submitGpuJob`: listing tags is metadata, not GPU inference.
 */
export async function listInstalledOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${getOllamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const body = await res.json() as { models?: OllamaTagsModel[] };
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return [];
  }
}

/** Resolve which ollama model a given `pack_settings` key should use: the
 *  explicit override if it's still installed, else the first installed
 *  model, else `null` (no ollama models available at all). */
async function resolveModel(settingKey: string): Promise<string | null> {
  const configured = packModelsRepo.getSetting(PACK_ID, settingKey);
  const installed = await listInstalledOllamaModels();
  if (configured && installed.includes(configured)) return configured;
  if (configured) {
    logger.warn('[ollamaAssist] configured model not installed, falling back to first available', {
      settingKey,
      configured,
    });
  }
  return installed[0] ?? null;
}

export function resolveSuggestionModel(): Promise<string | null> {
  return resolveModel(SUGGESTION_MODEL_SETTING);
}

export function resolveLyricsModel(): Promise<string | null> {
  return resolveModel(LYRICS_MODEL_SETTING);
}

/**
 * One-shot, non-streaming Ollama chat completion, scheduled through the
 * `llm-chat` GPU slot. Returns the assistant message content, or `null` on
 * any failure (unreachable ollama, non-2xx, timeout) — callers treat `null`
 * as "degrade to a local fallback", never as a thrown error, since neither
 * lyrics nor prompt suggestions are worth failing a request over.
 */
export async function ollamaChat(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  try {
    return await submitGpuJob('llm-chat', async (release) => {
      try {
        const res = await fetch(`${getOllamaUrl()}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            stream: false,
            options: {
              temperature: opts.temperature ?? 0.85,
              num_predict: opts.maxTokens ?? 512,
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          logger.warn('[ollamaAssist] chat completion failed', { model, status: res.status });
          return null;
        }
        const body = await res.json() as { message?: { content?: string } };
        return body.message?.content?.trim() || null;
      } finally {
        release();
      }
    });
  } catch (err) {
    logger.warn('[ollamaAssist] chat completion errored', {
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
