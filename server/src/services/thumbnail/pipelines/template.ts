// Template-asset pipeline: fetch a file from ComfyUI's `/templates/<assetPath>`
// endpoint, resize through sharp, cache on disk. Replaces the old
// `/api/template-asset/*` proxy by routing through the unified thumbnail
// service so all three modes (URL, gallery DB, template) share resize +
// disk cache + missing-source placeholder semantics.
//
// Trust model: assetPath is server-controlled (it comes from the templates
// catalog), same trust level as DB-mode local paths. Hence no IMG_PROXY
// allow-list check — that gate exists for user-supplied URL mode only.

import { createHash } from 'crypto';
import { createWriteStream, createReadStream, unlinkSync } from 'fs';
import sharp from 'sharp';
import { env } from '../../../config/env.js';
import { cachePathForKey, peekCached, publishTmp } from '../cache.js';
import { thumbnailPlaceholder } from './static.js';
import type { ThumbError, ThumbResult } from '../types.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

/**
 * Reject path segments that could escape the templates dir. Mirrors the
 * checks the legacy `isSafeAssetPath` helper applied in templates.routes.ts:
 * no NUL byte, no `..`, no leading `/` (which would make the URL absolute
 * relative to the upstream host root rather than the templates subtree).
 */
function isSafeTemplateAssetPath(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('/')) return false;
  return true;
}

/** Cache key: distinct namespace prefix so a future asset re-using the
 *  same path with a new format doesn't collide with a prior cache entry. */
function templateAssetKey(assetPath: string, width: number): string {
  return createHash('md5').update(`template|${assetPath}|${width}|webp`).digest('hex');
}

async function pipeBufferToWebp(
  bytes: Buffer, width: number, tmpPath: string, finalPath: string,
): Promise<void> {
  const pipeline = sharp(bytes).resize({ width, withoutEnlargement: true }).webp({ quality: 82 });
  const out = createWriteStream(tmpPath);
  try {
    await new Promise<void>((resolve, reject) => {
      pipeline.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      pipeline.pipe(out);
    });
    publishTmp(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

export interface TemplateAssetArgs {
  assetPath: string;
  width: number;
}

export async function thumbnailForTemplateAsset(
  args: TemplateAssetArgs,
): Promise<ThumbResult> {
  if (!isSafeTemplateAssetPath(args.assetPath)) {
    throw { code: 'INVALID_PATH' } satisfies ThumbError;
  }

  const key = templateAssetKey(args.assetPath, args.width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };

  const url = `${env.COMFYUI_URL}/templates/${args.assetPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw {
      code: 'UPSTREAM_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ThumbError;
  }
  clearTimeout(timer);

  // Source missing: caller wants a placeholder that the browser doesn't
  // cache so the real asset shows up on the next render once it lands.
  if (res.status === 404) return thumbnailPlaceholder();
  if (!res.ok) {
    throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ThumbError;
  }

  const declared = parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ThumbError;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw { code: 'UPSTREAM_FAILED', status: res.status } satisfies ThumbError;
  }

  const { tmpPath, filePath } = cachePathForKey(key);
  try {
    await pipeBufferToWebp(bytes, args.width, tmpPath, filePath);
  } catch (err) {
    throw {
      code: 'UPSTREAM_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ThumbError;
  }
  return { kind: 'file', filePath, contentType: 'image/webp', cached: false };
}
