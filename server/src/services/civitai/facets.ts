// Dynamic facet probe for the CivitAI search UI.
//
// `getBaseModelsFacet()` calls CivitAI's /models endpoint sorted by
// Most-Downloaded/AllTime and harvests distinct `modelVersions[0].baseModel`
// values. Results are cached in-memory for one hour so the facets endpoint
// can be called per-page-load without hammering upstream.
//
// On any upstream failure we degrade gracefully to a small hardcoded list so
// the UI is never left without filter chips; the failure is cached briefly
// (60s) so a transient blip recovers on the next call instead of being
// pinned for the full TTL.

import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { encodeQuery, type CivitaiListResponse } from './models.js';

/** Conservative fallback used when the upstream facet probe fails. */
export const CIVITAI_BASE_MODELS_FALLBACK = [
  'SD 1.5',
  'SDXL 1.0',
  'Pony',
  'Illustrious',
  'Flux.1 D',
  'Flux.1 S',
  'SD 3.5',
  'Qwen Image',
  'Wan Video',
] as const;

interface BaseModelsCacheEntry { values: string[]; expiresAt: number }
let _baseModelsCache: BaseModelsCacheEntry | null = null;
const BASE_MODELS_TTL_MS = 60 * 60 * 1000; // 1h per task spec
const BASE_MODELS_TTL_FAIL_MS = 60_000;    // 60s on failure

async function fetchJsonRaw(url: string): Promise<unknown> {
  // Inline copy of models.ts' fetchJson to avoid a circular helper export —
  // the facet probe is the only second consumer.
  const { fetchWithRetry } = await import('../../lib/http.js');
  const r = await fetchWithRetry(url, {
    attempts: 3,
    baseDelayMs: 500,
    timeoutMs: 15_000,
    maxBytes: env.CIVITAI_MAX_RESPONSE_BYTES,
    headers: { Accept: 'application/json' },
  });
  try { return JSON.parse(r.text); }
  catch (err) {
    throw new Error(
      `Civitai response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Probe a representative slice of CivitAI's most-downloaded models, extract
 * distinct `modelVersions[0].baseModel` values, dedupe + sort alphabetically.
 * Cached for 1h to avoid hammering upstream — the facet list is global, not
 * per-request.
 */
export async function getBaseModelsFacet(): Promise<string[]> {
  const now = Date.now();
  if (_baseModelsCache && _baseModelsCache.expiresAt > now) return _baseModelsCache.values;
  const params = { sort: 'Most Downloaded', period: 'AllTime', limit: 100, nsfw: false };
  try {
    const raw = (await fetchJsonRaw(
      `${env.CIVITAI_API_BASE}/models${encodeQuery(params)}`,
    )) as CivitaiListResponse;
    const seen = new Set<string>();
    for (const it of raw.items ?? []) {
      const item = it as { modelVersions?: Array<{ baseModel?: unknown }> };
      const bm = item.modelVersions?.[0]?.baseModel;
      if (typeof bm === 'string' && bm.length > 0) seen.add(bm);
    }
    const values = Array.from(seen).sort((a, b) => a.localeCompare(b));
    const final = values.length > 0 ? values : Array.from(CIVITAI_BASE_MODELS_FALLBACK);
    _baseModelsCache = { values: final, expiresAt: now + BASE_MODELS_TTL_MS };
    return final;
  } catch (err) {
    logger.warn('civitai baseModels facet probe failed; using fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = Array.from(CIVITAI_BASE_MODELS_FALLBACK);
    _baseModelsCache = { values: fallback, expiresAt: now + BASE_MODELS_TTL_FAIL_MS };
    return fallback;
  }
}

/** Test-only: reset the baseModels cache so tests don't bleed into each other. */
export function _resetBaseModelsCache(): void { _baseModelsCache = null; }
