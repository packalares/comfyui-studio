// Helper for `GET /api/ps` — Ollama's "currently loaded models" endpoint.
//
// Two consumers:
//   1. The cold-load hint in `streamChat.ts` (`isModelLoaded`) — fires the
//      "Loading model into VRAM…" banner *immediately* when the next
//      /api/chat will reload, instead of waiting 1.5s for the timer
//      fallback.
//   2. The context meter in `contextWindow.ts` (`getLoadedContextLength`)
//      — when the conversation is on Auto (no per-chat `num_ctx`
//      override), we read the model's actual `context_length` allocation
//      from /api/ps and use it as the meter's budget. That's the only
//      honest source of "what num_ctx is Ollama using right now"; the
//      modelfile / `/api/show` reports the *theoretical max*, not what's
//      loaded.
//
// Best-effort: a failed /api/ps (network glitch, older Ollama without
// the endpoint) returns `null` and the caller falls back to whatever
// degraded path it has.

const PS_TIMEOUT_MS = 500;

interface PsModelEntry {
  name?: string;
  model?: string;
  context_length?: number;
}
interface PsResponse {
  models?: PsModelEntry[];
}

async function fetchPs(baseUrl: string): Promise<PsResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PS_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/ps`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json() as PsResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function findModel(body: PsResponse | null, model: string): PsModelEntry | null {
  if (!body || !Array.isArray(body.models)) return null;
  return body.models.find((m) => m?.name === model || m?.model === model) ?? null;
}

/**
 * Returns true if `model` is currently loaded in Ollama's VRAM, false if
 * not loaded, null when /api/ps is unreachable. The match is on either
 * `name` or `model` — Ollama 0.5+ returns both fields and historically
 * one or the other has been the canonical id depending on version.
 */
export async function isModelLoaded(
  baseUrl: string, model: string,
): Promise<boolean | null> {
  if (!model) return null;
  const body = await fetchPs(baseUrl);
  if (body === null) return null;
  return findModel(body, model) !== null;
}

/**
 * Returns the actual `num_ctx` Ollama allocated for `model` on its current
 * load. `null` when the model isn't loaded yet, /api/ps is unreachable, or
 * the field is missing from the response (older Ollama). Caller should
 * treat null as "we don't know yet" — typical UX is to show an "Auto"
 * placeholder until the next request lands and the meter can re-fetch.
 */
export async function getLoadedContextLength(
  baseUrl: string, model: string,
): Promise<number | null> {
  if (!model) return null;
  const body = await fetchPs(baseUrl);
  const entry = findModel(body, model);
  if (!entry) return null;
  const n = entry.context_length;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}
