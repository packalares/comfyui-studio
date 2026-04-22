// Image pipeline: sharp-based resize for local files or fetched remote
// bytes. The local-file path is new for the unified service (the legacy
// `imgProxy.service` only handled URLs); the remote path preserves the
// allow-list + size-cap behaviour of `imgProxy.service` so civitai /
// huggingface URLs keep working under /api/thumbnail?url=...

import { createWriteStream, createReadStream, unlinkSync } from 'fs';
import sharp from 'sharp';
import { env } from '../../../config/env.js';
import { hostIsAllowed } from '../../imgProxy/imgProxy.service.js';
import {
  cachePathForKey, localFileKey, peekCached, publishTmp, remoteUrlKey,
} from '../cache.js';
import type { ThumbError, ThumbFileResult } from '../types.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const USER_AGENT = 'comfyui-studio-thumbs';

async function pipeSharpToFile(
  input: NodeJS.ReadableStream | Buffer,
  width: number,
  tmpPath: string,
  finalPath: string,
): Promise<void> {
  // Bounded webp quality — matches the legacy imgProxy service so a cutover
  // doesn't regress visible thumbnail quality.
  const pipeline = sharp().resize({ width, withoutEnlargement: true }).webp({ quality: 82 });
  const out = createWriteStream(tmpPath);
  try {
    await new Promise<void>((resolve, reject) => {
      pipeline.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      if (Buffer.isBuffer(input)) {
        pipeline.end(input);
      } else {
        input.on('error', reject);
        input.pipe(pipeline);
      }
      pipeline.pipe(out);
    });
    publishTmp(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export async function thumbnailForLocalImage(
  absPath: string, width: number,
): Promise<ThumbFileResult> {
  const key = localFileKey(absPath, width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };
  const { tmpPath, filePath } = cachePathForKey(key);
  try {
    await pipeSharpToFile(createReadStream(absPath), width, tmpPath, filePath);
  } catch (err) {
    throw {
      code: 'UPSTREAM_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ThumbError;
  }
  return { kind: 'file', filePath, contentType: 'image/webp', cached: false };
}

async function fetchBytes(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ThumbError;
    }
    const declared = parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ThumbError;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_RESPONSE_BYTES) {
      throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ThumbError;
    }
    return buf;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) throw err;
    throw { code: 'UPSTREAM_FAILED' } satisfies ThumbError;
  } finally {
    clearTimeout(timer);
  }
}

export async function thumbnailForRemoteImage(
  url: string, width: number,
): Promise<ThumbFileResult> {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw { code: 'HOST_NOT_ALLOWED' } satisfies ThumbError; }
  if (!hostIsAllowed(parsed.hostname, env.IMG_PROXY_ALLOWED_HOSTS)) {
    throw { code: 'HOST_NOT_ALLOWED' } satisfies ThumbError;
  }
  const key = remoteUrlKey(url, width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };
  const bytes = await fetchBytes(url);
  const { tmpPath, filePath } = cachePathForKey(key);
  try {
    await pipeSharpToFile(bytes, width, tmpPath, filePath);
  } catch (err) {
    throw {
      code: 'UPSTREAM_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ThumbError;
  }
  return { kind: 'file', filePath, contentType: 'image/webp', cached: false };
}

/** Used by the audio pipeline to cache a Pexels-fetched JPEG as webp. */
export async function writeBufferAsThumbnail(
  bytes: Buffer, key: string, width: number,
): Promise<ThumbFileResult> {
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };
  const { tmpPath, filePath } = cachePathForKey(key);
  await pipeSharpToFile(bytes, width, tmpPath, filePath);
  return { kind: 'file', filePath, contentType: 'image/webp', cached: false };
}
