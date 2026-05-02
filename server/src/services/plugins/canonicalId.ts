// Canonical-id resolver for plugin references.
//
// ComfyUI nodes carry two parallel identifier systems:
//   - aux_id: GitHub `owner/repo` form (e.g. `kijai/ComfyUI-WanAnimatePreprocess`)
//   - cnr_id: Comfy Node Registry id (e.g. `ComfyUI-WanAnimatePreprocess`)
// Both refer to the same plugin but they're different strings, so plain
// string-equality dedup falsely treats them as separate plugins.
//
// `canonicalize` normalizes any reference to the GitHub `owner/repo` form
// when possible. Bare CNR ids are looked up against `api.comfy.org/nodes/<id>`
// to fetch their declared GitHub repository; results are cached on disk
// under `~/.config/comfyui-studio/runtime/cnr-resolutions.json` so a
// restart doesn't re-hit the network for entries we've already resolved.
//
// `dedupKey` is the value to use as a Map key when grouping references
// from any source — it falls back to the bare repo basename so two
// entries that should match but couldn't be resolved (CNR offline) still
// collapse together via their shared basename.

import fs from 'fs';
import path from 'path';
import { paths } from '../../config/paths.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

const CACHE_FILE = path.join(paths.runtimeStateDir, 'cnr-resolutions.json');
const CNR_BASE = 'https://api.comfy.org/nodes';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheState {
  // In-memory: Map<lowercase cnr_id, lowercase owner/repo>. Insertion order
  // backs the FIFO eviction below — JS Maps preserve it natively.
  resolutions: Map<string, string>;
  // In-memory: negative cache as a Set so .has is O(1). Was an array; the
  // O(n) .includes scan grew quadratic with cache size.
  notFound: Set<string>;
  // Last successful refresh epoch ms. Stale resolutions get re-fetched
  // after CACHE_MAX_AGE_MS so renamed/moved registry entries propagate.
  fetchedAt: number;
}

// Hard caps prevent the in-memory cache from growing without bound when
// repeatedly probed with novel ids. FIFO eviction (oldest insertion drops
// first) keeps the hot set at the top.
const MAX_RESOLUTIONS = 10_000;
const MAX_NOT_FOUND = 10_000;

function trimMap<V>(map: Map<string, V>, max: number): void {
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) return;
    map.delete(oldestKey);
  }
}

function trimSet(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldestKey = set.values().next().value;
    if (oldestKey === undefined) return;
    set.delete(oldestKey);
  }
}

let memCache: CacheState | null = null;

function loadCacheFromDisk(): CacheState {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as {
        resolutions?: Record<string, string>;
        notFound?: string[];
        fetchedAt?: number;
      };
      if (parsed && typeof parsed === 'object') {
        // On-disk format stays {resolutions: object, notFound: array} for
        // backwards compatibility; convert to Map/Set on load.
        return {
          resolutions: new Map(Object.entries(parsed.resolutions ?? {})),
          notFound: new Set(parsed.notFound ?? []),
          fetchedAt: parsed.fetchedAt ?? 0,
        };
      }
    }
  } catch (err) {
    logger.warn('canonicalId: cache load failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return { resolutions: new Map(), notFound: new Set(), fetchedAt: 0 };
}

function persistCache(): void {
  if (!memCache) return;
  try {
    // Convert back to plain JSON-friendly shapes so the on-disk file stays
    // backwards compatible with older builds that read it as object/array.
    const onDisk = {
      resolutions: Object.fromEntries(memCache.resolutions),
      notFound: Array.from(memCache.notFound),
      fetchedAt: memCache.fetchedAt,
    };
    atomicWrite(CACHE_FILE, JSON.stringify(onDisk, null, 2));
  } catch (err) {
    logger.warn('canonicalId: cache persist failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function ensureCache(): CacheState {
  if (!memCache) memCache = loadCacheFromDisk();
  return memCache;
}

/** Strip protocol, `.git` suffix, trailing slashes; lowercase. The raw
 *  shape we then test for `/`-presence to know if we already have an
 *  owner/repo form. */
export function normalizeRepoKey(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

/** Last `/`-separated segment, or the whole string when no slash. */
export function repoBasename(repoKey: string): string {
  const slash = repoKey.lastIndexOf('/');
  return slash < 0 ? repoKey : repoKey.slice(slash + 1);
}

/**
 * Hot-path canonicalize: cache + sync only, never hits the network. Use
 * inside dedup loops or sync handlers where awaiting isn't viable. Pre-warm
 * with `canonicalize` (async) before the loop if you want freshness.
 */
export function canonicalizeSync(raw: string): string {
  const key = normalizeRepoKey(raw);
  if (!key) return key;
  if (key.includes('/')) return key;
  const cache = ensureCache();
  return cache.resolutions.get(key) ?? key;
}

/**
 * Async canonicalize: hits CNR for unknown bare ids, persists the result,
 * returns the canonical owner/repo form. Network failures and 404s are
 * cached as well so repeated calls don't pile up requests.
 *
 * The function is idempotent and safe to call concurrently for the same
 * id — there's no inflight dedup map. Each caller pays the network cost
 * the first time and reads from the persisted cache thereafter.
 */
export async function canonicalize(raw: string): Promise<string> {
  const key = normalizeRepoKey(raw);
  if (!key) return key;
  if (key.includes('/')) return key;
  const cache = ensureCache();
  const cached = cache.resolutions.get(key);
  if (cached !== undefined) {
    if (Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) {
      return cached;
    }
  }
  if (cache.notFound.has(key)) return key;

  try {
    const res = await fetch(`${CNR_BASE}/${encodeURIComponent(key)}`);
    if (!res.ok) {
      // 404 -> never going to resolve. Cache the negative for the TTL.
      cache.notFound.add(key);
      trimSet(cache.notFound, MAX_NOT_FOUND);
      cache.fetchedAt = Date.now();
      persistCache();
      return key;
    }
    const data = await res.json() as { repository?: string };
    if (typeof data.repository === 'string' && data.repository.length > 0) {
      const canonical = normalizeRepoKey(data.repository);
      // Re-set the key so its insertion order moves to most-recent,
      // matching FIFO-evict semantics on the older end.
      cache.resolutions.delete(key);
      cache.resolutions.set(key, canonical);
      trimMap(cache.resolutions, MAX_RESOLUTIONS);
      cache.fetchedAt = Date.now();
      persistCache();
      return canonical;
    }
    cache.notFound.add(key);
    trimSet(cache.notFound, MAX_NOT_FOUND);
    cache.fetchedAt = Date.now();
    persistCache();
    return key;
  } catch (err) {
    logger.warn('canonicalId: CNR lookup failed', {
      key, message: err instanceof Error ? err.message : String(err),
    });
    return key;
  }
}

/**
 * Dedup key for grouping plugin references that should be treated as the
 * same plugin. Uses the basename so an entry that resolved to
 * `kijai/comfyui-wananimatepreprocess` collapses with an unresolved
 * `comfyui-wananimatepreprocess` (CNR offline).
 *
 * Intentionally lossy — owner-prefix aside, the basename uniquely
 * identifies plugins in practice (no two registered plugins share a
 * repo basename).
 */
export function dedupKey(canonicalOrRaw: string): string {
  return repoBasename(canonicalizeSync(canonicalOrRaw));
}

/**
 * Pre-warm the cache for a batch of references so subsequent
 * `canonicalizeSync` calls return resolved values. Use before entering a
 * tight dedup loop.
 */
export async function preheat(refs: string[]): Promise<void> {
  await Promise.all(refs.map((r) => canonicalize(r)));
}

/** Test-only seed. Accepts the previous on-disk shape (object/array) for
 *  call-site convenience and converts internally to the runtime Map/Set. */
export function _seedForTests(state: {
  resolutions?: Record<string, string> | Map<string, string>;
  notFound?: string[] | Set<string>;
  fetchedAt?: number;
}): void {
  const resolutions = state.resolutions instanceof Map
    ? new Map(state.resolutions)
    : new Map(Object.entries(state.resolutions ?? {}));
  const notFound = state.notFound instanceof Set
    ? new Set(state.notFound)
    : new Set(state.notFound ?? []);
  memCache = {
    resolutions,
    notFound,
    fetchedAt: state.fetchedAt ?? Date.now(),
  };
}

/** Test-only reset. */
export function _resetForTests(): void {
  memCache = null;
}
