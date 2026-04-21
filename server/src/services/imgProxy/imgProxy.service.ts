// Image proxy + on-disk thumbnail cache. The SPA calls /api/img?url=...&w=...
// and we return a size-reduced webp/jpeg so the browser never pulls
// multi-megabyte origin images straight off civitai / huggingface CDNs.
//
// Cache key is md5(url + '|' + width + '|' + format). Files live under
// `<COMFYUI_PATH>/.cache/thumbs/<md5>.<format>`. URLs served via /api/img
// are content-addressed (the URL contains the source URL + width), so a
// long-lived immutable Cache-Control is safe — if the source URL changes,
// the browser will request a new path.
//
// NOTE: the cache grows unbounded over disk. A future sweep job (LRU or
// age-based) can be added if disk usage becomes an issue — intentionally
// punted for this wave.
//
// The service throws typed errors: `{ code: 'HOST_NOT_ALLOWED' | 'INVALID_WIDTH' }`
// for user-input failures and `{ code: 'UPSTREAM_FAILED', status?: number }`
// for origin fetch / non-2xx responses. The route layer maps these onto 400/502.

import { createHash } from 'crypto';
import { existsSync, statSync, mkdirSync, createWriteStream, unlinkSync, renameSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { env } from '../../config/env.js';

export type ImgProxyFormat = 'webp' | 'jpeg';

export interface ProxyImageArgs {
  url: string;
  width: number;
  format?: ImgProxyFormat;
}

export interface ProxyImageResult {
  filePath: string;
  cached: boolean;
  contentType: string;
}

export interface ImgProxyError {
  code: 'HOST_NOT_ALLOWED' | 'INVALID_WIDTH' | 'UPSTREAM_FAILED';
  status?: number;
}

const MIN_WIDTH = 32;
const MAX_WIDTH = 2048;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024; // 25 MiB
const USER_AGENT = 'comfyui-studio-imgproxy';

export function isImgProxyError(err: unknown): err is ImgProxyError {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'HOST_NOT_ALLOWED' || code === 'INVALID_WIDTH' || code === 'UPSTREAM_FAILED';
}

/**
 * Returns true when `hostname` matches any entry in the allow-list.
 * Entry semantics:
 *   - `example.com`    -> exact match
 *   - `.example.com`   -> suffix match (matches `foo.example.com`, not `example.com`)
 */
export function hostIsAllowed(hostname: string, allowed: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  for (const raw of allowed) {
    const entry = raw.toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('.')) {
      if (h.endsWith(entry)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

function cacheDir(): string {
  return path.join(env.COMFYUI_PATH || '/root/ComfyUI', '.cache', 'thumbs');
}

function cacheKey(url: string, width: number, format: ImgProxyFormat): string {
  return createHash('md5').update(`${url}|${width}|${format}`).digest('hex');
}

function validateWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isInteger(width)) {
    throw { code: 'INVALID_WIDTH' } satisfies ImgProxyError;
  }
  if (width < MIN_WIDTH || width > MAX_WIDTH) {
    throw { code: 'INVALID_WIDTH' } satisfies ImgProxyError;
  }
  return width;
}

function validateUrl(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw { code: 'HOST_NOT_ALLOWED' } satisfies ImgProxyError; }
  if (!hostIsAllowed(parsed.hostname, env.IMG_PROXY_ALLOWED_HOSTS)) {
    throw { code: 'HOST_NOT_ALLOWED' } satisfies ImgProxyError;
  }
  return parsed;
}

async function fetchOrigin(url: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ImgProxyError;
    }
    const declared = parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ImgProxyError;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) {
      throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ImgProxyError;
    }
    return buf;
  } catch (err) {
    if (isImgProxyError(err)) throw err;
    throw { code: 'UPSTREAM_FAILED' } satisfies ImgProxyError;
  } finally {
    clearTimeout(timer);
  }
}

async function writeResized(
  bytes: ArrayBuffer,
  width: number,
  format: ImgProxyFormat,
  finalPath: string,
): Promise<void> {
  const tmpPath = `${finalPath}.tmp`;
  try {
    const pipeline = sharp(Buffer.from(bytes))
      .resize({ width, withoutEnlargement: true })
      .toFormat(format, { quality: 82 });
    const out = createWriteStream(tmpPath);
    await new Promise<void>((resolve, reject) => {
      pipeline.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      pipeline.pipe(out);
    });
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    if (isImgProxyError(err)) throw err;
    throw { code: 'UPSTREAM_FAILED' } satisfies ImgProxyError;
  }
}

export async function proxyImage(args: ProxyImageArgs): Promise<ProxyImageResult> {
  const format: ImgProxyFormat = args.format ?? 'webp';
  const width = validateWidth(args.width);
  validateUrl(args.url);

  const dir = cacheDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = cacheKey(args.url, width, format);
  const filePath = path.join(dir, `${key}.${format}`);
  const contentType = `image/${format}`;

  if (existsSync(filePath)) {
    try {
      if (statSync(filePath).size > 0) {
        return { filePath, cached: true, contentType };
      }
    } catch { /* fall through to miss path */ }
  }

  const bytes = await fetchOrigin(args.url);
  await writeResized(bytes, width, format, filePath);
  return { filePath, cached: false, contentType };
}
