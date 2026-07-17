// Model-asset pipeline: read a model's local `.preview.webp` sidecar (written
// by the enrichment layer), resize through sharp, cache on disk. Mirrors the
// template-asset pipeline so all thumbnail modes (URL / gallery / template /
// model) share resize + disk cache + missing-source placeholder semantics.
//
// Trust model: (save_path, filename) is resolved against the model_files
// DB; the abs_path is server-controlled (scanned from COMFYUI_PATH).

import { createHash } from 'crypto';
import { createWriteStream, existsSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as modelFiles from '../../../lib/db/modelFiles.repo.js';
import { readSidecar, findExistingPreview } from '../../models/enrichment/sidecar.js';
import { cachePathForKey, peekCached, publishTmp } from '../cache.js';
import { thumbnailPlaceholder } from './static.js';
import type { ThumbError, ThumbResult } from '../types.js';

function modelAssetKey(save_path: string, filename: string, width: number): string {
  return createHash('md5')
    .update(`model|${save_path}|${filename}|${width}|webp`)
    .digest('hex');
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

export interface ModelAssetArgs {
  save_path: string;
  filename: string;
  width: number;
}

export async function thumbnailForModelAsset(args: ModelAssetArgs): Promise<ThumbResult> {
  if (!args.save_path || !args.filename) {
    throw { code: 'INVALID_PATH' } satisfies ThumbError;
  }

  const key = modelAssetKey(args.save_path, args.filename, args.width);
  const hit = peekCached(key);
  if (hit) return { kind: 'file', filePath: hit, contentType: 'image/webp', cached: true };

  // Resolve abs_path via the model_files index.
  const rows = modelFiles.listByFilename(args.filename);
  const match = rows.find(
    (r) => r.rel_path === `${args.save_path}/${args.filename}` && r.status === 'complete',
  ) ?? rows[0];
  if (!match) return thumbnailPlaceholder();

  // The preview can be any of: our `.preview.webp`, CLM's `.jpeg` we reused,
  // or other extensions findExistingPreview knows about. Use the sidecar's
  // `preview_local_path` when present (set by enrichOne); otherwise probe.
  const sidecar = readSidecar(match.abs_path);
  const previewBasename = sidecar?.preview_local_path
    ?? findExistingPreview(match.abs_path);
  if (!previewBasename) return thumbnailPlaceholder();
  const previewPath = path.join(path.dirname(match.abs_path), previewBasename);
  if (!existsSync(previewPath)) return thumbnailPlaceholder();

  const bytes = readFileSync(previewPath);
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
