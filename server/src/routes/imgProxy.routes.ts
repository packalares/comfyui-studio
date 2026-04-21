// GET /api/img — image proxy endpoint backed by the md5 disk cache.
//
// Query params:
//   - url (required)  : http(s) URL of the upstream image. Host must be on
//                       env.IMG_PROXY_ALLOWED_HOSTS.
//   - w   (required)  : target width in pixels (integer, 32..2048).
//   - fmt (optional)  : `webp` (default) | `jpeg`.
//
// The response sets `Cache-Control: public, max-age=31536000, immutable`
// because /api/img URLs are content-addressed (they include the source URL
// and width) — if the source changes, the browser will build a different
// /api/img URL and bypass its cached copy automatically.
//
// Dual-mounted at `/img` + `/launcher/img` to match the pattern used by
// other proxy endpoints (see view.routes.ts, civitai.routes.ts).

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
