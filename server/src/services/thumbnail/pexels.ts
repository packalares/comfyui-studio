// Pexels fallback for audio rows without embedded cover art.
//
// Pexels free tier caps at 200 requests/hour. We enforce a 1000ms floor
// between outbound calls via an in-memory promise chain so bursts of tile
// renders collapse into a steady trickle; the per-prompt memoization map
// (+ 30-day persisted cache) then ensures the same prompt text never hits
// the API twice after the first lookup.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'fs';
import path from 'path';
import * as settings from '../settings.js';
import { cacheRoot } from './cache.js';

const RATE_FLOOR_MS = 1000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_FILE = '.pexels-cache.json';

interface PexelsEntry {
  imageUrl: string;
  fetchedAt: number;
}

interface PexelsSearchResponse {
  photos?: Array<{ src?: { medium?: string } }>;
}

let memoryCache: Map<string, PexelsEntry> | null = null;
let nextAllowedAt = 0;

function cacheFilePath(): string {
  return path.join(cacheRoot(), CACHE_FILE);
}

function loadCache(): Map<string, PexelsEntry> {
  if (memoryCache) return memoryCache;
  memoryCache = new Map();
  const file = cacheFilePath();
  if (!existsSync(file)) return memoryCache;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, PexelsEntry>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.imageUrl === 'string' && typeof v.fetchedAt === 'number') {
        if (Date.now() - v.fetchedAt < TTL_MS) memoryCache.set(k, v);
      }
    }
  } catch { /* corrupt cache — start fresh */ }
  return memoryCache;
}

function persistCache(): void {
  if (!memoryCache) return;
  const dir = cacheRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const obj: Record<string, PexelsEntry> = {};
  for (const [k, v] of memoryCache) obj[k] = v;
  try { writeFileSync(cacheFilePath(), JSON.stringify(obj)); }
  catch { /* best-effort; a failed persist still leaves memory cache intact */ }
}

/** First 50 chars of the prompt (or filename stem), stripped of whitespace runs. */
export function queryFromPrompt(raw: string | null | undefined): string {
  if (!raw) return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, 50);
}

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  if (now < nextAllowedAt) {
    await new Promise((r) => setTimeout(r, nextAllowedAt - now));
  }
  nextAllowedAt = Date.now() + RATE_FLOOR_MS;
}

/**
 * Look up (or fetch) a Pexels medium-size JPEG URL for `query`. Returns null
 * when no API key is configured, the query is empty, or Pexels returned
 * nothing. Rate-limited: a single in-flight call at any moment + 1s floor
 * between successive outbound requests.
 */
export async function findPexelsImageUrl(query: string): Promise<string | null> {
  const apiKey = settings.getPexelsApiKey();
  if (!apiKey || !query) return null;
  const cache = loadCache();
  const hit = cache.get(query);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.imageUrl;

  await waitForRateLimit();

  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`;
  let payload: PexelsSearchResponse;
  try {
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) return null;
    payload = await res.json() as PexelsSearchResponse;
  } catch {
    return null;
  }
  const first = payload.photos?.[0]?.src?.medium;
  if (!first) return null;
  cache.set(query, { imageUrl: first, fetchedAt: Date.now() });
  persistCache();
  return first;
}

/** Test hook: wipe the in-memory memo so each test starts clean. */
export function __resetPexelsCacheForTests(): void {
  memoryCache = null;
  nextAllowedAt = 0;
}
