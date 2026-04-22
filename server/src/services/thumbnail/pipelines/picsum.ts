// Lorem Picsum fallback. No API key, deterministic by seed, returns a
// stock photo from picsum.photos. Used between Pexels (which needs a key
// + prompt relevance) and the static Music SVG (last-resort) — so the
// default install still renders a unique-looking cover per audio row
// without any external credentials.

import { createHash } from 'crypto';
import { peekCached } from '../cache.js';
import { writeBufferAsThumbnail } from './image.js';
import type { ThumbResult } from '../types.js';

const PICSUM_TIMEOUT_MS = 8_000;

/** Stable short seed derived from any unique-per-row string (absPath or url). */
export function seedFromSource(source: string): string {
  return createHash('md5').update(source).digest('hex').slice(0, 12);
}

function cacheKey(seed: string, width: number): string {
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

/**
 * Resolve (or fetch) a Picsum thumbnail for the given seed. Returns null
 * on any network/CDN failure so the caller can fall through to the SVG.
 */
export async function thumbnailFromPicsum(
  seed: string, width: number,
): Promise<ThumbResult | null> {
  const key = cacheKey(seed, width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };
  try {
    const bytes = await fetchPicsumBytes(seed, width);
    return await writeBufferAsThumbnail(bytes, key, width);
  } catch {
    return null;
  }
}
