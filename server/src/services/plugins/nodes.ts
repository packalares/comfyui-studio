// Plugin node resolution: aux_id ↔ cnr_id canonicalization (CNR network
// lookup + on-disk cache) and class_type → plugin resolver backed by
// ComfyUI-Manager's `GET /customnode/getmappings?mode=cache`.

import fs from 'fs';
import path from 'path';
import { paths } from '../../config/paths.js';
import { env } from '../../config/env.js';
import { atomicWrite } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';

// ---- Canonical ID (aux_id ↔ cnr_id) ----
//
// `canonicalize` normalizes any reference to the GitHub `owner/repo` form.
// Bare CNR ids are looked up against `api.comfy.org/nodes/<id>`; results are
// cached on disk under `~/.config/comfyui-studio/runtime/cnr-resolutions.json`
// so a restart doesn't re-hit the network for known entries.

const CACHE_FILE = path.join(paths.runtimeStateDir, 'cnr-resolutions.json');
const CNR_BASE = 'https://api.comfy.org/nodes';
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CanonicalCacheState {
  // Map<lowercase cnr_id, lowercase owner/repo>. JS Map insertion order
  // backs FIFO eviction — oldest entry drops first.
  resolutions: Map<string, string>;
  // Negative cache as Set so .has is O(1).
  notFound: Set<string>;
  fetchedAt: number;
}

// Hard caps prevent unbounded growth when repeatedly probed with novel ids.
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

let memCache: CanonicalCacheState | null = null;

function loadCacheFromDisk(): CanonicalCacheState {
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
    // Convert back to plain JSON-friendly shapes for backwards compatibility.
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

function ensureCanonicalCache(): CanonicalCacheState {
  if (!memCache) memCache = loadCacheFromDisk();
  return memCache;
}

/** Strip protocol, `.git` suffix, trailing slashes; lowercase. */
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
 * inside dedup loops or sync handlers. Pre-warm with `canonicalize` (async)
 * before the loop if you want freshness.
 */
export function canonicalizeSync(raw: string): string {
  const key = normalizeRepoKey(raw);
  if (!key) return key;
  if (key.includes('/')) return key;
  const cache = ensureCanonicalCache();
  return cache.resolutions.get(key) ?? key;
}

/**
 * Async canonicalize: hits CNR for unknown bare ids, persists the result.
 * Network failures and 404s are cached so repeated calls don't pile up requests.
 */
export async function canonicalize(raw: string): Promise<string> {
  const key = normalizeRepoKey(raw);
  if (!key) return key;
  if (key.includes('/')) return key;
  const cache = ensureCanonicalCache();
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
      // 404 → never going to resolve; cache the negative for the TTL.
      cache.notFound.add(key);
      trimSet(cache.notFound, MAX_NOT_FOUND);
      cache.fetchedAt = Date.now();
      persistCache();
      return key;
    }
    const data = await res.json() as { repository?: string };
    if (typeof data.repository === 'string' && data.repository.length > 0) {
      const canonical = normalizeRepoKey(data.repository);
      // Re-set so insertion order moves to most-recent (FIFO eviction semantics).
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
 * Dedup key using the basename so `kijai/comfyui-wananimatepreprocess` and
 * the unresolved `comfyui-wananimatepreprocess` collapse to the same key.
 */
export function dedupKey(canonicalOrRaw: string): string {
  return repoBasename(canonicalizeSync(canonicalOrRaw));
}

/** Pre-warm the cache for a batch of references. */
export async function preheat(refs: string[]): Promise<void> {
  await Promise.all(refs.map((r) => canonicalize(r)));
}

// ---- Node map: class_type → plugin resolver ----
//
// Source of truth is ComfyUI-Manager's `GET /customnode/getmappings?mode=cache`,
// which returns `extension-node-map.json` keyed by repository URL. We invert
// this map once per hour so `extractDepsAsync` can resolve raw LiteGraph nodes
// that have no `aux_id`/`cnr_id`. A single class_type may appear in multiple
// repos — we preserve every match so the UI can surface the ambiguity.
//
// Degrade rule: when Manager is unreachable, every class_type returns
// `{matches: []}` — the caller renders an "unresolved" badge.

export interface PluginMapMatch {
  /** Canonical repo URL (e.g. https://github.com/x/y). */
  repo: string;
  /** Display title from Manager's `title_aux`. Falls back to repo. */
  title: string;
  cnr_id?: string;
}

export interface PluginResolution {
  classType: string;
  matches: PluginMapMatch[];
}

type ManagerMappings = Record<string, unknown>;

const NODE_MAP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB safety cap

interface NodeMapCacheState {
  /** Inverted index: class_type (lowercased) -> list of plugin matches. */
  index: Map<string, PluginMapMatch[]>;
  fetchedAt: number;
}

let nodeMapState: NodeMapCacheState | null = null;
let nodeMapInflight: Promise<NodeMapCacheState | null> | null = null;
let degradedLogged = false;

function normalizeRepo(url: string): string {
  return url.trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

/**
 * Parse a single Manager entry. Returns null on malformed rows — we skip
 * rather than throw so one bad row doesn't break the whole index.
 */
function parseEntry(repo: string, raw: unknown): {
  classTypes: string[]; match: PluginMapMatch;
} | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [classes, meta] = raw;
  if (!Array.isArray(classes)) return null;
  const classTypes: string[] = [];
  for (const c of classes) {
    if (typeof c === 'string' && c.length > 0) classTypes.push(c);
  }
  if (classTypes.length === 0) return null;
  let title = '';
  let cnr: string | undefined;
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    if (typeof m.title_aux === 'string') title = m.title_aux;
    if (typeof m.cnr_id === 'string' && m.cnr_id.length > 0) cnr = m.cnr_id;
  }
  const repoClean = normalizeRepo(repo);
  return {
    classTypes,
    match: {
      repo: repoClean,
      title: title.length > 0 ? title : repoClean,
      cnr_id: cnr,
    },
  };
}

function buildIndex(data: ManagerMappings): Map<string, PluginMapMatch[]> {
  const idx = new Map<string, PluginMapMatch[]>();
  for (const [repo, raw] of Object.entries(data)) {
    const parsed = parseEntry(repo, raw);
    if (!parsed) continue;
    for (const cls of parsed.classTypes) {
      const key = cls.toLowerCase();
      const bucket = idx.get(key);
      if (bucket) {
        // Dedup by repo — some forks list the same class under the same URL
        // via different capitalizations.
        if (!bucket.some((m) => m.repo === parsed.match.repo)) {
          bucket.push(parsed.match);
        }
      } else {
        idx.set(key, [parsed.match]);
      }
    }
  }
  return idx;
}

async function fetchMappings(): Promise<ManagerMappings | null> {
  try {
    const url = `${env.COMFYUI_URL}/customnode/getmappings?mode=cache`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`response too large (${contentLength} bytes)`);
    }
    const body = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('unexpected response shape');
    }
    return body as ManagerMappings;
  } catch (err) {
    if (!degradedLogged) {
      degradedLogged = true;
      logger.warn('nodeMap: Manager /customnode/getmappings unreachable; resolver degraded', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  }
}

async function ensureFresh(): Promise<NodeMapCacheState | null> {
  const now = Date.now();
  if (nodeMapState && now - nodeMapState.fetchedAt < NODE_MAP_CACHE_TTL_MS) return nodeMapState;
  if (nodeMapInflight) return nodeMapInflight;
  nodeMapInflight = (async () => {
    try {
      const data = await fetchMappings();
      if (!data) return null;
      const index = buildIndex(data);
      nodeMapState = { index, fetchedAt: Date.now() };
      degradedLogged = false;
      logger.info('nodeMap: refreshed class_type -> plugin index', {
        classTypes: index.size,
      });
      return nodeMapState;
    } finally {
      nodeMapInflight = null;
    }
  })();
  return nodeMapInflight;
}

/**
 * Resolve a list of workflow class_types to their owning plugin repos via
 * Manager's authoritative index. Class types with zero matches are returned
 * with `matches: []` so the caller can render an "unresolved" badge.
 */
export async function resolveNodeTypes(
  classTypes: string[],
): Promise<PluginResolution[]> {
  const uniq = new Set<string>();
  for (const raw of classTypes) {
    if (typeof raw === 'string' && raw.length > 0) uniq.add(raw);
  }
  const out: PluginResolution[] = [];
  const cache = await ensureFresh();
  const idx = cache?.index;
  for (const cls of uniq) {
    const matches = idx?.get(cls.toLowerCase());
    out.push({
      classType: cls,
      matches: matches ? matches.map((m) => ({ ...m })) : [],
    });
  }
  return out;
}

/** Force a cache rebuild. Used by tests and future UI "Refresh" action. */
export function invalidate(): void {
  nodeMapState = null;
  nodeMapInflight = null;
  degradedLogged = false;
}

/** Test-only seed: inject a mappings object directly, skipping the HTTP fetch. */
export function _seedForTests(data: ManagerMappings): void {
  nodeMapState = { index: buildIndex(data), fetchedAt: Date.now() };
}
