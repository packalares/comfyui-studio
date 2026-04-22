// Audio pipeline: embedded cover art -> Pexels (if API key set) ->
// Picsum (keyless, seeded) -> static Music SVG.
//
// The ID3v2 APIC / FLAC PICTURE / MP4 covr atoms all show up to ffmpeg as
// an attached picture stream. `-map 0:v -frames:v 1 -c copy` copies the raw
// bytes to a temp file without re-encoding, so ffmpeg doesn't need sharp-
// level understanding of the underlying format; sharp then takes the
// output and resizes to webp. If the source has no picture stream, we try
// Pexels (only when the user configured an API key — prompt-relevant
// search), otherwise fall through to Picsum (keyless, deterministic stock
// photo by seed) and finally the static Music SVG.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { findPexelsImageUrl } from '../pexels.js';
import { localFileKey, peekCached } from '../cache.js';
import { writeBufferAsThumbnail } from './image.js';
import { thumbnailFromPicsum, seedFromSource } from './picsum.js';
import { inlineMusicSvg } from './static.js';
import type { ThumbResult } from '../types.js';

const FFMPEG_COVER_TIMEOUT_MS = 10_000;

/** Try to extract an embedded cover picture; returns null on any failure. */
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

  // Picsum — keyless, deterministic per source path. Every audio row gets
  // a unique-looking stock cover when Pexels isn't configured or missed.
  const picsum = await thumbnailFromPicsum(seedFromSource(absPath), width);
  if (picsum) return picsum;

  return inlineMusicSvg();
}

async function fetchPexelsBytes(url: string): Promise<Buffer> {
  // Pexels image CDN (images.pexels.com) is not on the IMG_PROXY allow-list,
  // but these URLs come directly from the Pexels API response, not user
  // input, so we bypass the allow-list check and fetch directly.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pexels fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** URL-mode entry: no local file, just falls through to Pexels / SVG. */
export async function thumbnailForRemoteAudio(
  url: string, width: number, queryText: string,
): Promise<ThumbResult> {
  // URL-mode audio fetched from remote CDNs skips embedded-cover extraction
  // (would require buffering the full audio to a tmp file to hand to
  // ffmpeg). Goes straight to Pexels / SVG. DB-mode paths through ComfyUI's
  // output dir always resolve to a local absPath and call thumbnailForLocalAudio.
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
