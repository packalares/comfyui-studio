// Dynamic follow-up suggestions for the assistant turn that just finished.
//
// Fires a one-shot non-streaming `/api/chat` call asking the active model to
// propose three short follow-up prompts the user might want to send next.
// The result is broadcast over WS as `chat:suggestions` so the thread can
// swap out its static heuristic pills for model-aware ones.
//
// Best-effort by design: if the upstream times out, returns malformed JSON,
// or 502s, we log and emit nothing — the UI keeps the static fallback.
// Lives apart from `streamChat.ts` so the main streaming hot path can stay
// focused on lifecycle + telemetry.

import { logger } from '../../lib/logger.js';
import * as repo from '../../lib/db/chat.repo.js';
import type { OllamaChatMessage } from './ollamaChat.js';

const SUGGESTION_TIMEOUT_MS = 8000;
const SYSTEM_PROMPT = [
  'You are a helpful assistant suggesting natural next-step prompts the USER might send.',
  'Read the conversation and propose exactly three short follow-up prompts (≤ 8 words each).',
  'Reply with ONLY a JSON array of strings — no prose, no markdown, no code fences.',
  'Example: ["Show me an example", "Explain that further", "What about edge cases?"]',
].join(' ');

/** Project the recent N messages of a conversation into Ollama wire shape. */
function recentTranscript(conversationId: string, n = 6): OllamaChatMessage[] {
  const all = repo.listMessages(conversationId);
  const tail = all.slice(-n);
  const out: OllamaChatMessage[] = [];
  for (const r of tail) {
    let parts: unknown = [];
    try { parts = JSON.parse(r.parts); } catch { /* keep parts = [] */ }
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter(p => p && typeof p === 'object' && (p as { type?: string }).type === 'text')
      .map(p => String((p as { text?: string }).text ?? ''))
      .join('')
      .trim();
    if (!text) continue;
    if (r.role === 'user' || r.role === 'assistant' || r.role === 'system') {
      out.push({ role: r.role, content: text });
    }
  }
  return out;
}

/**
 * Strip leading/trailing markdown/code fences/text noise that small models
 * sometimes wrap around the JSON, then attempt JSON.parse on the slice
 * between the first `[` and the last `]`. Returns up to 3 short strings or
 * an empty array on any failure (caller falls back to static suggestions).
 */
export function parseSuggestionsJson(raw: string): string[] {
  if (!raw) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  const slice = raw.slice(start, end + 1);
  let parsed: unknown;
  try { parsed = JSON.parse(slice); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > 80) continue;
    out.push(trimmed);
    if (out.length === 3) break;
  }
  return out;
}

export interface GenerateSuggestionsInput {
  conversationId: string;
  baseUrl: string;
  model: string;
  /** Same num_ctx the main /api/chat call used. Passing it here keeps
   *  Ollama's KV-cache aligned — without it the upstream allocates with
   *  its own default (2048) and the next user-send reloads the model.
   *  Both calls match → no churn between turns. */
  numCtx?: number;
}

/**
 * Run the suggestion-generation request. Returns up to 3 strings; empty on
 * any failure path (timeout, non-2xx, JSON parse failure). Caller is
 * expected to skip the WS emit when the result is empty so the UI's static
 * fallback keeps showing.
 */
export async function generateSuggestions(
  input: GenerateSuggestionsInput,
): Promise<string[]> {
  const transcript = recentTranscript(input.conversationId);
  if (transcript.length === 0) return [];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUGGESTION_TIMEOUT_MS);
  try {
    const res = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...transcript,
          { role: 'user', content: 'Suggest 3 short follow-up prompts I might send next. JSON array only.' },
        ],
        stream: false,
        // Tiny output budget — we only need ~50 tokens. Keeps the call fast
        // even on slow CPUs and avoids the model rambling into prose.
        // `num_ctx` mirrors the main chat's value so Ollama doesn't reload
        // the KV-cache between the assistant turn and this sidecar.
        options: {
          num_predict: 120,
          temperature: 0.7,
          ...(input.numCtx && input.numCtx > 0 ? { num_ctx: input.numCtx } : {}),
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn('suggestions: upstream non-2xx', {
        status: res.status, statusText: res.statusText,
      });
      return [];
    }
    const body = await res.json() as { message?: { content?: unknown } };
    const content = typeof body?.message?.content === 'string' ? body.message.content : '';
    return parseSuggestionsJson(content);
  } catch (err) {
    logger.warn('suggestions: generation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    clearTimeout(timer);
  }
}
