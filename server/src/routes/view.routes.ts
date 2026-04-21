// Media-file serving for gallery rows. The gallery stores
// `/api/view?filename=X&subfolder=Y&type=Z` URLs that the browser hits to
// render the image/video/audio. Originally these forwarded to ComfyUI's own
// `/api/view` — which meant every media request required ComfyUI to be
// reachable, even though our backend has direct filesystem access to the
// same `${COMFYUI_PATH}/<type>/...` tree.
//
// Behaviour now:
//   1. Resolve the local path and stream it via `fs.createReadStream` with
//      the right Content-Type + basic Range support (so video seeking
//      works without loading the whole file).
//   2. Fall back to proxying ComfyUI only when the local read fails
//      (rare — usually a mount mismatch or a file ComfyUI generated in a
//      path we don't have visibility into).
//
// Path segments are sanitized against traversal before the path is
// composed, and the resolved path is checked against the configured
// output root to prevent escaping the expected directory tree.

import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';
import * as comfyui from '../services/comfyui.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const router = Router();

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sanitizePathSegment(value: string | undefined): string | null {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  if (value.includes('\0')) return null;
  if (value.includes('..')) return null;
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return null;
  return value;
}

/** Resolve the on-disk path for a `/view` request or null if malformed. */
function resolveLocal(
  filename: string, subfolder: string, type: string,
): { absPath: string; rootAbs: string } | null {
  const root = env.COMFYUI_PATH;
  if (!root) return null;
  // ComfyUI maps ?type= to a sibling directory under COMFYUI_PATH. Any
  // value we haven't explicitly listed is rejected so a crafted type can't
  // escape into arbitrary tree positions.
  const typeDir = ({ output: 'output', input: 'input', temp: 'temp' } as const)[
    (type || 'output') as 'output' | 'input' | 'temp'
  ];
  if (!typeDir) return null;
  const rootAbs = path.resolve(root, typeDir);
  const abs = path.resolve(
    rootAbs,
    subfolder || '',
    filename,
  );
  // Final traversal guard — `resolve` normalises `..` segments even though
  // we rejected them at sanitize time, so double-check the composed path
  // still lives under the type-dir.
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) return null;
  return { absPath: abs, rootAbs };
}

/** Stream the local file with optional Range support. Returns true if served. */
function serveLocal(
  absPath: string, filename: string, req: Request, res: Response,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const contentType = mimeFor(filename);
  const totalSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < totalSize) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        res.setHeader('Content-Length', String(end - start + 1));
        fs.createReadStream(absPath, { start, end }).pipe(res);
        return true;
      }
    }
  }
  res.setHeader('Content-Length', String(totalSize));
  fs.createReadStream(absPath).pipe(res);
  return true;
}

router.get('/view', async (req: Request, res: Response) => {
  const rawFilename = req.query.filename;
  const rawSubfolder = req.query.subfolder;
  const rawType = req.query.type;

  if (typeof rawFilename !== 'string' || rawFilename.length === 0) {
    res.status(400).json({ error: 'filename required' });
    return;
  }
  const filename = sanitizePathSegment(rawFilename);
  const subfolder = sanitizePathSegment(
    typeof rawSubfolder === 'string' ? rawSubfolder : undefined,
  );
  const type = sanitizePathSegment(
    typeof rawType === 'string' ? rawType : undefined,
  );
  if (filename === null || subfolder === null || type === null) {
    res.status(400).json({ error: 'invalid path segment' });
    return;
  }

  // Fast path — serve from disk directly. Works even when ComfyUI is down.
  const local = resolveLocal(filename, subfolder, type || 'output');
  if (local && serveLocal(local.absPath, filename, req, res)) return;

  // Fall back to ComfyUI for anything we couldn't resolve locally.
  try {
    const upstream = await comfyui.proxyView(filename, subfolder || undefined);
    if (!upstream.ok) {
      res.status(upstream.status).end();
      return;
    }
    const contentType = upstream.headers.get('content-type') ?? mimeFor(filename);
    res.setHeader('Content-Type', contentType);
    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    logger.warn('view: local + upstream both failed', {
      filename,
      subfolder,
      type,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ error: 'Media not available' });
  }
});

export default router;
