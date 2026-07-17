// CivitAI implementation of ModelSource.
// Reuses the `fetchWithRetry` + env config already used by civitai/models.ts.
//
// Endpoints:
//   GET  {base}/model-versions/by-hash/{sha256}   — single hash
//   POST {base}/model-versions/by-hash             — batch (body: string[])

import { env } from '../../../config/env.js';
import { fetchWithRetry } from '../../../lib/http.js';
import { getCivitaiToken } from '../../settings/index.js';
import { logger } from '../../../lib/logger.js';
import type { ModelSource, ModelSourceResult, ModelType } from './types.js';

// ---- Raw CivitAI response shapes (minimal, validated at runtime) ----

interface CivitaiImage {
  url?: string;
  nsfwLevel?: number;
  type?: string;
}

interface CivitaiVersionRaw {
  id?: number;
  modelId?: number;
  description?: string;          // version-level description (some creators write here)
  trainedWords?: string[];
  baseModel?: string;
  images?: CivitaiImage[];
  model?: {
    id?: number;
    name?: string;
    description?: string;        // model-level description (most common)
    tags?: string[];
    nsfw?: boolean;
    nsfwLevel?: number;
  };
}

// ---- Auth header builder ----

function civitaiAuthHeaders(): Record<string, string> {
  const token = getCivitaiToken();
  if (!token) return { Accept: 'application/json' };
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

function apiBase(): string {
  return env.CIVITAI_API_BASE;
}

function maxBytes(): number {
  return env.CIVITAI_MAX_RESPONSE_BYTES;
}

// ---- Parse helper ----

function parseVersion(raw: CivitaiVersionRaw): ModelSourceResult {
  const model = raw.model ?? {};
  const images = Array.isArray(raw.images) ? raw.images : [];

  // Derive NSFW level: max nsfwLevel across all images, fallback to model.nsfwLevel.
  let nsfwLevel: number | undefined;
  for (const img of images) {
    if (typeof img.nsfwLevel === 'number') {
      nsfwLevel = Math.max(nsfwLevel ?? 0, img.nsfwLevel);
    }
  }
  if (nsfwLevel === undefined && typeof model.nsfwLevel === 'number') {
    nsfwLevel = model.nsfwLevel;
  }

  // Preview: first image URL (any type).
  const previewImage = images.find((i) => typeof i.url === 'string');
  const previewRemoteUrl = previewImage?.url;

  const triggerWords = Array.isArray(raw.trainedWords)
    ? raw.trainedWords.filter((w): w is string => typeof w === 'string')
    : [];

  const tags = Array.isArray(model.tags)
    ? model.tags.filter((t): t is string => typeof t === 'string')
    : [];

  return {
    metadata_source: 'civitai',
    civitai_version_id: typeof raw.id === 'number' ? raw.id : undefined,
    civitai_model_id: typeof raw.modelId === 'number'
      ? raw.modelId
      : (typeof model.id === 'number' ? model.id : undefined),
    model_name: typeof model.name === 'string' ? model.name : undefined,
    base_model: typeof raw.baseModel === 'string' ? raw.baseModel : undefined,
    // CivitAI puts description at either model-level OR version-level depending
    // on the model. Some creators write it on the version (which is `raw`),
    // others on the model. Prefer model-level (more general) but fall back.
    description: typeof model.description === 'string'
      ? model.description
      : (typeof raw.description === 'string' ? raw.description : undefined),
    tags,
    trigger_words: triggerWords,
    nsfw_level: nsfwLevel,
    preview_remote_url: typeof previewRemoteUrl === 'string' ? previewRemoteUrl : undefined,
    civitai_raw: raw,
  };
}

// ---- CivitaiModelSource ----

export class CivitaiModelSource implements ModelSource {
  /**
   * Look up a single model version by its full-file SHA256.
   * Returns null when the model isn't found on CivitAI (404) or the request
   * fails.
   */
  async searchByHash(sha256: string): Promise<ModelSourceResult | null> {
    const url = `${apiBase()}/model-versions/by-hash/${encodeURIComponent(sha256)}`;
    logger.info('civitai by-hash lookup', { sha256: sha256.slice(0, 12) + '...' });
    try {
      const r = await fetchWithRetry(url, {
        attempts: 3,
        baseDelayMs: 500,
        timeoutMs: 15_000,
        maxBytes: maxBytes(),
        headers: civitaiAuthHeaders(),
      });
      const raw = JSON.parse(r.text) as CivitaiVersionRaw;
      const result = parseVersion(raw);
      // by-hash returns version + a stripped `model` block (name/type/nsfw only,
      // no description). Fetch the full model record by id for description.
      if (result && result.civitai_model_id) {
        const desc = await this.fetchModelDescription(result.civitai_model_id);
        if (desc) result.description = desc;
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 is expected for models not on CivitAI — log at info, not warn.
      if (msg.includes('404') || msg.includes('not found')) {
        logger.info('civitai by-hash: not found', { sha256: sha256.slice(0, 12) });
      } else {
        logger.warn('civitai by-hash: request failed', { sha256: sha256.slice(0, 12), error: msg });
      }
      return null;
    }
  }

  /** Fetch the model record by id and return its description HTML.
   *  CivitAI's by-hash endpoint returns only a stripped model block;
   *  GET /models/{id} returns the full record including `description`. */
  private async fetchModelDescription(modelId: number): Promise<string | undefined> {
    const url = `${apiBase()}/models/${modelId}`;
    try {
      const r = await fetchWithRetry(url, {
        attempts: 2,
        baseDelayMs: 500,
        timeoutMs: 10_000,
        maxBytes: maxBytes(),
        headers: civitaiAuthHeaders(),
      });
      const body = JSON.parse(r.text) as { description?: unknown };
      return typeof body.description === 'string' ? body.description : undefined;
    } catch (err) {
      logger.info('civitai model fetch failed', {
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Batch lookup: POST body is an array of sha256 hashes (max 100).
   * Returns a map of lowercase-sha256 → result.
   */
  async searchByHashBatch(
    hashes: string[],
  ): Promise<Map<string, ModelSourceResult>> {
    if (hashes.length === 0) return new Map();
    const url = `${apiBase()}/model-versions/by-hash`;
    logger.info('civitai batch by-hash', { count: hashes.length });
    try {
      const r = await fetchWithRetry(url, {
        attempts: 2,
        baseDelayMs: 500,
        timeoutMs: 20_000,
        maxBytes: maxBytes(),
        headers: { ...civitaiAuthHeaders(), 'Content-Type': 'application/json' },
      });
      // Note: fetchWithRetry is GET-only; for POST we use native fetch.
      void r; // won't reach here — POST path uses native fetch below.
    } catch { /* see POST impl below */ }

    // fetchWithRetry is GET-only. Use native fetch for the POST.
    const result = new Map<string, ModelSourceResult>();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...civitaiAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(hashes),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn('civitai batch by-hash: upstream error', { status: res.status });
        return result;
      }
      const raw = await res.json() as Record<string, CivitaiVersionRaw>;
      for (const [hash, version] of Object.entries(raw)) {
        result.set(hash.toLowerCase(), parseVersion(version));
      }
    } catch (err) {
      logger.warn('civitai batch by-hash: request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return result;
  }

  /** Name-based search — stub; not used by Phase 1 enrichment flow. */
  async searchByName(_filename: string, _modelType: ModelType): Promise<ModelSourceResult | null> {
    return null;
  }
}

export const civitaiSource = new CivitaiModelSource();
