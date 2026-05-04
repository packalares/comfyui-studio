// Phase F context-window tracking. Exposes the model's total token budget
// (Ollama's `num_ctx`) plus a heuristic estimate of how many tokens the
// running conversation has consumed, so the UI can render a meter and
// strategies (sliding / summarize / manual) can decide when to compact.
//
// `num_ctx` is read from Ollama's `/api/show` endpoint (POST `{ name }`).
// Field names match Ollama's docs: response carries either `parameters`
// (free-form string of `key value` lines) and / or `model_info` (typed map
// where the architecture-specific `<arch>.context_length` is the canonical
// budget). We try both and prefer the larger of the two.
//
// Cached per model with a 1h TTL — the value is set at load time and only
// changes when the user re-pulls / re-imports a model file.

import * as settings from '../settings.js';
import * as repo from '../../lib/db/chat.repo.js';
import { getStrategy, lastAssistantMessage } from '../../lib/db/chat.context.repo.js';
import { getLoadedContextLength } from './ollamaPs.js';

export interface ContextWindowInfo {
  /** Total budget for the model. Ollama refers to this as `num_ctx`. */
  num_ctx: number;
  model: string;
}

export interface UsageState {
  used: number;
  /** Token budget the meter draws against. Numeric when we know the
   *  exact runtime allocation (user pinned a value, OR model is loaded
   *  and `/api/ps` reported its `context_length`). `null` when on Auto
   *  and the model isn't loaded yet — the UI shows an "Auto"
   *  placeholder until the next request lands and we can re-fetch. */
  budget: number | null;
  /** used / budget * 100 (clamped to [0, 100]). 0 when `budget` is null. */
  percent: number;
  /** Heuristic estimate of the pending user message + system prompt cost. */
  estimatedNext: number;
  warning: 'green' | 'yellow' | 'red';
  /** Active strategy on the conversation row (sliding by default). */
  strategy: 'sliding' | 'auto';
  model: string;
  /** Model's published architectural max context (e.g. 131072 for llama3.1)
   *  read from `/api/show`. Used by the UI as the upper bound of the
   *  context-window slider. `null` when /api/show is unreachable. */
  modelMaxCtx: number | null;
  /** Per-conversation runtime override. `null` means "use Ollama default" — the
   *  send path omits `options.num_ctx` in that case. */
  numCtx: number | null;
  /** Per-conversation reasoning-mode override. `null` = "auto" (model
   *  default); `'on'` / `'off'` map to `think: true|false` on the request. */
  thinkMode: 'on' | 'off' | null;
  /** Per-conversation sampling temperature override. `null` = Ollama default. */
  temperature: number | null;
  /** Per-conversation output format override. `null` = free text. */
  format: 'json' | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry {
  info: ContextWindowInfo | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Heuristic for in-flight messages that haven't been tokenized yet. We pick
 * the larger of two cheap estimators:
 *   - characters / 4 — works well for English-ish ASCII;
 *   - words * 1.3 — better for short whitespace-separated inputs.
 * Real tokenization is model-specific and would need llama.cpp / tiktoken,
 * neither of which we want as a runtime dep just for a meter.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = Math.ceil(text.length / 4);
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const wordEstimate = Math.ceil(words * 1.3);
  return Math.max(chars, wordEstimate);
}

interface OllamaShowResponse {
  parameters?: string;
  model_info?: Record<string, unknown>;
}

/**
 * Pull `num_ctx` out of an `/api/show` payload. Order of precedence:
 *   1. `parameters` (free-form `key value` lines, one per line);
 *   2. `model_info.<arch>.context_length`.
 * If both are present we take the larger value — Ollama caps `num_ctx`
 * downward to 2048 on some models, but the underlying weight has the full
 * window; we report the larger one so the meter matches what the user
 * could realistically use.
 */
export function parseNumCtx(payload: OllamaShowResponse): number | null {
  let fromParams: number | null = null;
  if (typeof payload?.parameters === 'string') {
    for (const line of payload.parameters.split(/\r?\n/)) {
      const m = /^\s*num_ctx\s+(\d+)\s*$/.exec(line);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) { fromParams = n; break; }
      }
    }
  }
  let fromInfo: number | null = null;
  const info = payload?.model_info;
  if (info && typeof info === 'object') {
    for (const [k, v] of Object.entries(info)) {
      if (!k.endsWith('.context_length')) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > 0) {
        if (fromInfo === null || n > fromInfo) fromInfo = n;
      }
    }
  }
  if (fromParams === null && fromInfo === null) return null;
  return Math.max(fromParams ?? 0, fromInfo ?? 0);
}

export async function getModelContext(modelName: string): Promise<ContextWindowInfo | null> {
  if (!modelName) return null;
  const cached = cache.get(modelName);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const baseUrl = settings.getOllamaUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  let info: ContextWindowInfo | null = null;
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: ctrl.signal,
    });
    if (res.ok) {
      const body = await res.json() as OllamaShowResponse;
      const num = parseNumCtx(body);
      if (num !== null) info = { num_ctx: num, model: modelName };
    }
  } catch { /* leave info null; caller falls back to settings.chatFallbackNumCtx */ }
  finally { clearTimeout(timer); }

  cache.set(modelName, { info, expiresAt: Date.now() + CACHE_TTL_MS });
  return info;
}

/** Test seam — drops the cache so vitest can re-stub fetch between cases. */
export function _resetContextCache(): void { cache.clear(); }

function classify(percent: number): UsageState['warning'] {
  if (percent >= 80) return 'red';
  if (percent >= 50) return 'yellow';
  return 'green';
}

export interface ComputeUsageInput {
  conversationId: string;
  model: string;
  pendingUserText?: string;
}

export async function computeUsage(input: ComputeUsageInput): Promise<UsageState> {
  const ctx = await getModelContext(input.model);
  const conv = repo.getConversation(input.conversationId);
  // Budget priority — what we report as the "denominator" for the meter:
  //   1. conversation.num_ctx (user pinned via the slider). Sent on every
  //      request as `options.num_ctx`, so this is what Ollama allocates.
  //   2. /api/ps `context_length` (model is loaded; Ollama auto-picked
  //      its own default — typically the modelfile's value). The most
  //      honest "what's actually allocated right now" signal we have.
  //   3. null — model not loaded yet AND no override; we genuinely don't
  //      know the budget. UI shows an "Auto" placeholder.
  let budget: number | null = conv?.num_ctx ?? null;
  if (budget === null) {
    const baseUrl = settings.getOllamaUrl();
    budget = await getLoadedContextLength(baseUrl, input.model);
  }

  const lastAssistant = lastAssistantMessage(input.conversationId);
  const consumed = lastAssistant?.tokens_in ?? 0;

  const systemTokens = conv?.system_prompt
    ? estimateTokens(conv.system_prompt)
    : 0;
  const pendingTokens = input.pendingUserText
    ? estimateTokens(input.pendingUserText)
    : 0;
  const estimatedNext = systemTokens + pendingTokens;
  const used = consumed + estimatedNext;
  const percent = budget !== null && budget > 0
    ? Math.max(0, Math.min(100, (used / budget) * 100))
    : 0;

  const strategy = getStrategy(input.conversationId);
  return {
    used, budget, percent, estimatedNext,
    warning: classify(percent),
    strategy,
    model: input.model,
    modelMaxCtx: ctx?.num_ctx ?? null,
    numCtx: conv?.num_ctx ?? null,
    thinkMode: conv?.think_mode ?? null,
    temperature: conv?.temperature ?? null,
    format: conv?.format ?? null,
  };
}
