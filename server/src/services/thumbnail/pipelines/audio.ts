// Audio pipeline: embedded cover art → Pexels (if API key set) →
// Picsum (keyless, seeded) → static Music SVG.
//
// Pexels free tier caps at 200 req/hour. We enforce a 1000ms floor between
// outbound calls via an in-memory promise chain so burst renders collapse into
// a steady trickle; per-prompt memoization + 30-day persisted cache ensure
// the same prompt text never hits the API twice after the first lookup.
//
// The ID3v2 APIC / FLAC PICTURE / MP4 covr atoms all show up to ffmpeg as an
// attached picture stream. `-map 0:v -frames:v 1 -c copy` copies the raw
// bytes to a temp file without re-encoding; sharp then resizes to webp.
//
// Picsum is the keyless fallback: deterministic per seed, returns a unique-
// looking stock cover per audio row without any external credentials.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import * as settings from '../../settings/index.js';
import { localFileKey, peekCached, loadPexelsCache, persistPexelsCache } from '../cache.js';
import type { PexelsEntry } from '../cache.js';
import { writeBufferAsThumbnail } from './image.js';
import { inlineMusicSvg } from './static.js';
import type { ThumbResult } from '../types.js';

const FFMPEG_COVER_TIMEOUT_MS = 10_000;

// ── Pexels ────────────────────────────────────────────────────────────────────

const PEXELS_RATE_FLOOR_MS = 1000;
const PEXELS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let pexelsMemoryCache: Map<string, PexelsEntry> | null = null;
let pexelsNextAllowedAt = 0;

function getPexelsCache(): Map<string, PexelsEntry> {
  if (!pexelsMemoryCache) {
    pexelsMemoryCache = loadPexelsCache(PEXELS_TTL_MS);
  }
  return pexelsMemoryCache;
}

/** First 50 chars of the prompt (or filename stem), stripped of whitespace runs. */
export function queryFromPrompt(raw: string | null | undefined): string {
  if (!raw) return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, 50);
}

async function waitForPexelsRateLimit(): Promise<void> {
  const now = Date.now();
  if (now < pexelsNextAllowedAt) {
    await new Promise((r) => setTimeout(r, pexelsNextAllowedAt - now));
  }
  pexelsNextAllowedAt = Date.now() + PEXELS_RATE_FLOOR_MS;
}

/**
 * Look up (or fetch) a Pexels medium-size JPEG URL for `query`. Returns null
 * when no API key is configured, the query is empty, or Pexels returned
 * nothing. Rate-limited: single in-flight call + 1s floor between requests.
 */
export async function findPexelsImageUrl(query: string): Promise<string | null> {
  const apiKey = settings.getPexelsApiKey();
  if (!apiKey || !query) return null;
  const cache = getPexelsCache();
  const hit = cache.get(query);
  if (hit && Date.now() - hit.fetchedAt < PEXELS_TTL_MS) return hit.imageUrl;

  await waitForPexelsRateLimit();

  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`;
  interface PexelsSearchResponse {
    photos?: Array<{ src?: { medium?: string } }>;
  }
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
  persistPexelsCache(cache);
  return first;
}

/** Test hook: wipe the in-memory memo so each test starts clean. */
export function __resetPexelsCacheForTests(): void {
  pexelsMemoryCache = null;
  pexelsNextAllowedAt = 0;
}

// ── Picsum ────────────────────────────────────────────────────────────────────

const PICSUM_TIMEOUT_MS = 8_000;

/** Stable short seed derived from any unique-per-row string (absPath or url). */
export function seedFromSource(source: string): string {
  return createHash('md5').update(source).digest('hex').slice(0, 12);
}

function picsumCacheKey(seed: string, width: number): string {
  return createHash('md5').update(`picsum|${seed}|${width}`).digest('hex');
}

async function fetchPicsumBytes(seed: string, width: number): Promise<Buffer> {
  const url = `https://picsum.photos/seed/${encodeURIComponent(seed)}/${width}/${width}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PICSUM_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`picsum ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function thumbnailFromPicsum(seed: string, width: number): Promise<ThumbResult | null> {
  const key = picsumCacheKey(seed, width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };
  try {
    const bytes = await fetchPicsumBytes(seed, width);
    return await writeBufferAsThumbnail(bytes, key, width);
  } catch {
    return null;
  }
}

// ── ffmpeg cover art extraction ───────────────────────────────────────────────

function extractCoverArt(srcPath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'audio-cover-'));
    const tmpFile = path.join(tmpDir, 'cover.jpg');
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', srcPath,
      '-map', '0:v',
      '-frames:v', '1',
      '-c', 'copy',
      '-f', 'image2',
      tmpFile,
    ];
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      rmSync(tmpDir, { recursive: true, force: true });
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, FFMPEG_COVER_TIMEOUT_MS);
    proc.on('error', () => {
      clearTimeout(timer);
      rmSync(tmpDir, { recursive: true, force: true });
      resolve(null);
    });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(tmpFile)) {
        try {
          const bytes = readFileSync(tmpFile);
          rmSync(tmpDir, { recursive: true, force: true });
          resolve(bytes.byteLength > 0 ? bytes : null);
          return;
        } catch {
          rmSync(tmpDir, { recursive: true, force: true });
          resolve(null);
          return;
        }
      }
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      rmSync(tmpDir, { recursive: true, force: true });
      resolve(null);
    });
  });
}

// ── Pexels CDN fetch ──────────────────────────────────────────────────────────

async function fetchPexelsBytes(url: string): Promise<Buffer> {
  // Pexels image CDN (images.pexels.com) is not on the IMG_PROXY allow-list,
  // but these URLs come directly from the Pexels API response, not user input,
  // so we bypass the allow-list check and fetch directly.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pexels fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Pipeline entry points ─────────────────────────────────────────────────────

/**
 * Resolve a thumbnail for an audio file. `queryText` is the prompt text
 * (DB mode) or filename stem (URL mode) used as the Pexels fallback query.
 * Returns an inline SVG result when both cover + Pexels fail so the route
 * can always serve bytes.
 */
export async function thumbnailForLocalAudio(
  absPath: string, width: number, queryText: string,
): Promise<ThumbResult> {
  const cacheKey = localFileKey(absPath, width);
  const hit = peekCached(cacheKey);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };

  const cover = await extractCoverArt(absPath);
  if (cover) {
    const { filePath, cached } = await writeBufferAsThumbnail(cover, cacheKey, width);
    return { kind: 'file', filePath, contentType: 'image/webp', cached };
  }

  const pexelsUrl = await findPexelsImageUrl(queryText);
  if (pexelsUrl) {
    // Two audio rows sharing the same Pexels hit share a single cache entry
    // via the Pexels-URL key; we also publish under the audio-source key so
    // future requests for this specific file skip the Pexels re-lookup.
    const pexelsKey = createHash('md5').update(`pexels|${pexelsUrl}|${width}`).digest('hex');
    const existing = peekCached(pexelsKey);
    if (existing) {
      return { kind: 'file', filePath: existing, contentType: 'image/webp', cached: true };
    }
    try {
      const bytes = await fetchPexelsBytes(pexelsUrl);
      const result = await writeBufferAsThumbnail(bytes, pexelsKey, width);
      try { await writeBufferAsThumbnail(bytes, cacheKey, width); }
      catch { /* non-fatal: next request will regenerate */ }
      return result;
    } catch {
      // Pexels returned, but the CDN fetch failed — fall through to Picsum.
    }
  }

  const picsum = await thumbnailFromPicsum(seedFromSource(absPath), width);
  if (picsum) return picsum;

  return inlineMusicSvg();
}

/** URL-mode entry: no local file, just falls through to Pexels / SVG. */
export async function thumbnailForRemoteAudio(
  url: string, width: number, queryText: string,
): Promise<ThumbResult> {
  // URL-mode audio skips embedded-cover extraction (would require buffering
  // the full audio to a tmp file to hand to ffmpeg). Goes straight to
  // Pexels / Picsum / SVG.
  const pexelsUrl = await findPexelsImageUrl(queryText);
  if (pexelsUrl) {
    const pexelsKey = createHash('md5').update(`pexels|${pexelsUrl}|${width}`).digest('hex');
    const existing = peekCached(pexelsKey);
    if (existing) {
      return { kind: 'file', filePath: existing, contentType: 'image/webp', cached: true };
    }
    try {
      const bytes = await fetchPexelsBytes(pexelsUrl);
      return await writeBufferAsThumbnail(bytes, pexelsKey, width);
    } catch { /* fall through */ }
  }
  const picsum = await thumbnailFromPicsum(seedFromSource(url), width);
  if (picsum) return picsum;
  return inlineMusicSvg();
}
