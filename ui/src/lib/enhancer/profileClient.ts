// Singleton fetch + cache for the prompt-enhancer profile library.
//
// The server exposes two endpoints under /api/enhancer:
//
//   GET /api/enhancer              — one-shot bundle: profile metadata list
//                                    + master header/footer + genres +
//                                    operations + negative defaults +
//                                    video presets.
//   GET /api/enhancer/profiles/:id — full profile JSON (examples,
//                                    platform_block, operation_overrides,
//                                    sampling, etc).
//
// The bundle is fetched once per session and cached at module scope. Per-
// profile fetches are cached in a Map keyed by id — the user might switch
// modes mid-session and we don't want to re-fetch the same profile.
//
// Hooks mirror the `usePromptRegistry` pattern: return null while
// in-flight, then the parsed value. Callers should treat null as "not
// loaded yet" and either show a loading state or fall back to the legacy
// template.promptEnhancer.systemPrompt path.

import { useEffect, useState } from 'react';

// ---- Types ---------------------------------------------------------
//
// Mirror the JSON schema documented in
// server/data/enhancer/profiles/<id>.json. Keep field names + casing
// EXACTLY in sync with the JSON files so the resolver doesn't need a
// translation layer.

export interface EnhancerExample {
  label: string;
  user_input: string;
  ideal_output: string;
  note?: string;
}

export interface EnhancerOperationOverride {
  length_guidance?: string;
  max_words?: number;
  min_word_floor?: number;
}

export interface EnhancerProfile {
  id: string;
  version: number;
  name: string;
  description: string;
  applies_to: string[];
  language_target?: string;

  format: string;
  prompt_style?: string;
  max_words: number;
  min_word_floor: number;
  length_guidance: string;
  detail_expectation: string;
  default_length_tier: string;

  preferences: string[];
  quality_tokens: string[];
  quality_emphasis?: boolean;
  avoid: string[];
  required_positive: string[];
  negative_prompt_default: string;
  supports_negative_prompt: boolean;
  platform_block: string;
  edit_templates?: string[];

  examples: EnhancerExample[];
  few_shot_intro?: string;
  user_message_schema_hint?: string;

  operation_overrides: Record<string, EnhancerOperationOverride>;

  model_routing: {
    preferred_llm: string;
    preferred_vlm: string;
    prefer_vlm_when_images_attached: boolean;
    sampling: {
      temperature: number;
      top_p: number;
      num_predict: number;
    };
  };

  provenance: {
    primary_sources: string[];
    borrowed_from: string[];
    notes: string;
  };
}

// Lightweight summary returned in the bundle's `profiles` array — full
// profile is fetched separately on demand.
export interface EnhancerProfileMeta {
  id: string;
  name?: string;
  description?: string;
  applies_to: string[];
  format?: string;
  default_length_tier?: string;
}

export interface EnhancerBundle {
  profiles: EnhancerProfileMeta[];
  master: { header: string; footer: string };
  genres: {
    description: string;
    provenance: string;
    genres: Record<string, string>;
  };
  operations: {
    description: string;
    provenance: string;
    operations: Record<string, {
      description: string;
      default_context: string;
      default_length_tier: string;
    }>;
    context_map: Record<string, string>;
    length_tiers: Record<string, {
      word_range: string;
      max_words_multiplier: number;
    }>;
  };
  negative_defaults: {
    description: string;
    provenance: string;
    defaults: Record<string, string>;
  };
  video_presets: {
    description: string;
    provenance: string;
    presets: Record<string, unknown>;
    random_pools: Record<string, unknown>;
  };
}

// ---- Singleton caches ----------------------------------------------

let bundleCached: EnhancerBundle | null = null;
let bundleInflight: Promise<EnhancerBundle | null> | null = null;
const bundleSubscribers = new Set<(b: EnhancerBundle | null) => void>();

const profileCache = new Map<string, EnhancerProfile>();
const profileInflight = new Map<string, Promise<EnhancerProfile | null>>();

// ---- Fetchers ------------------------------------------------------

export function fetchEnhancerBundle(): Promise<EnhancerBundle | null> {
  if (bundleCached) return Promise.resolve(bundleCached);
  if (bundleInflight) return bundleInflight;
  bundleInflight = fetch('/api/enhancer')
    .then(async (r) => {
      if (!r.ok) return null;
      const data = (await r.json()) as EnhancerBundle;
      bundleCached = data;
      bundleSubscribers.forEach((cb) => cb(data));
      return data;
    })
    .catch(() => null)
    .finally(() => {
      bundleInflight = null;
    });
  return bundleInflight;
}

export function fetchEnhancerProfile(id: string): Promise<EnhancerProfile | null> {
  const cached = profileCache.get(id);
  if (cached) return Promise.resolve(cached);
  const inflight = profileInflight.get(id);
  if (inflight) return inflight;
  const promise = fetch(`/api/enhancer/profiles/${encodeURIComponent(id)}`)
    .then(async (r) => {
      if (!r.ok) return null;
      const data = (await r.json()) as EnhancerProfile;
      profileCache.set(id, data);
      return data;
    })
    .catch(() => null)
    .finally(() => {
      profileInflight.delete(id);
    });
  profileInflight.set(id, promise);
  return promise;
}

// ---- React hooks ---------------------------------------------------

/**
 * Returns the enhancer bundle or null while loading.
 *
 * Bundle is fetched once per Studio session; subsequent hook calls in
 * any component reuse the cache. Components should treat `null` as
 * "use the legacy template.promptEnhancer.systemPrompt path" or render
 * a small loading state next to the Enhance button.
 */
export function useEnhancerBundle(): EnhancerBundle | null {
  const [bundle, setBundle] = useState<EnhancerBundle | null>(bundleCached);

  useEffect(() => {
    if (bundleCached) {
      // StrictMode double-mount: re-sync in case another caller resolved
      // while this component was mounting.
      setBundle(bundleCached);
      return;
    }
    let alive = true;
    const onResolve = (b: EnhancerBundle | null) => {
      if (alive) setBundle(b);
    };
    bundleSubscribers.add(onResolve);
    fetchEnhancerBundle();
    return () => {
      alive = false;
      bundleSubscribers.delete(onResolve);
    };
  }, []);

  return bundle;
}

/**
 * Returns a single profile by id, or null while loading / not-found.
 *
 * Triggers a fetch on mount if the profile isn't cached yet. The id can
 * be null to defer fetching until the caller has picked a profileId
 * (e.g. waiting for the active mode's `studioModes[mode].promptEnhancer
 * .profileId` to resolve).
 */
export function useEnhancerProfile(id: string | null): EnhancerProfile | null {
  const [profile, setProfile] = useState<EnhancerProfile | null>(
    id ? profileCache.get(id) ?? null : null,
  );

  useEffect(() => {
    if (!id) {
      setProfile(null);
      return;
    }
    let alive = true;
    fetchEnhancerProfile(id).then((p) => {
      if (alive) setProfile(p);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  return profile;
}
