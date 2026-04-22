// DEPRECATED — remove after UI migration lands.
// Back-compat adapter for `/api/img?url=...&w=...`. Delegates to the
// legacy `imgProxy.service` so pre-migration callers keep hitting the
// same `<COMFYUI_PATH>/.cache/thumbs/<md5>.<format>` cache path. The
// unified service (`/api/thumbnail?url=...`) is the migration target;
// once the UI is fully switched over this file and the legacy service
// can both be deleted.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { createReadStream } from 'fs';
import {
  proxyImage,
  isImgProxyError,
  type ImgProxyFormat,
} from '../services/imgProxy/imgProxy.service.js';

const router = Router();

function parseFormat(raw: unknown): ImgProxyFormat | { error: string } {
  if (raw == null || raw === '') return 'webp';
  if (raw === 'webp' || raw === 'jpeg') return raw;
  return { error: 'fmt must be webp or jpeg' };
}

function parseWidth(raw: unknown): number | { error: string } {
  if (typeof raw !== 'string' || raw === '') return { error: 'w is required' };
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return { error: 'w must be an integer' };
  return n;
}

const handleImgProxy: RequestHandler = async (req: Request, res: Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }
  const width = parseWidth(req.query.w);
  if (typeof width !== 'number') { res.status(400).json({ error: width.error }); return; }
  const fmt = parseFormat(req.query.fmt);
  if (typeof fmt !== 'string') { res.status(400).json({ error: fmt.error }); return; }

  try {
    const { filePath, contentType } = await proxyImage({ url, width, format: fmt });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    createReadStream(filePath).pipe(res);
  } catch (err) {
    if (isImgProxyError(err)) {
      if (err.code === 'HOST_NOT_ALLOWED') {
        res.status(400).json({ error: 'HOST_NOT_ALLOWED' });
        return;
      }
      if (err.code === 'INVALID_WIDTH') {
        res.status(400).json({ error: 'INVALID_WIDTH' });
        return;
      }
      res.status(502).json({ error: 'UPSTREAM_FAILED', status: err.status });
      return;
    }
    res.status(502).json({ error: 'UPSTREAM_FAILED' });
  }
};

router.get(['/img', '/launcher/img'], handleImgProxy);

export default router;
