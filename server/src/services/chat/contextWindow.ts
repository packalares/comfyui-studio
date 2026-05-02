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

export interface ContextWindowInfo {
  /** Total budget for the model. Ollama refers to this as `num_ctx`. */
  num_ctx: number;
  model: string;
}

export interface UsageState {
  used: number;
  budget: number;
  /** used / budget * 100 (clamped to [0, 100]). */
  percent: number;
  /** Heuristic estimate of the pending user message + system prompt cost. */
  estimatedNext: number;
  warning: 'green' | 'yellow' | 'red';
  /** Active strategy on the conversation row (sliding by default). */
  strategy: 'sliding' | 'summarize' | 'manual';
  model: string;
}

/** Fallback budget when /api/show is unreachable or the model is unknown. */
const FALLBACK_NUM_CTX = 4096;
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
  } catch { /* leave info null; caller falls back to FALLBACK_NUM_CTX */ }
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
  const budget = ctx?.num_ctx ?? FALLBACK_NUM_CTX;

  const conv = repo.getConversation(input.conversationId);
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
  const percent = budget > 0
    ? Math.max(0, Math.min(100, (used / budget) * 100))
    : 0;

  const strategy = getStrategy(input.conversationId);
  return {
    used, budget, percent, estimatedNext,
    warning: classify(percent),
    strategy,
    model: input.model,
  };
}
