// Template listing + single-template fetch + template asset proxy + raw
// workflow-JSON proxy. All driven by ComfyUI's /templates/* endpoint on the
// upstream; we simply add caching, API-key gating, and path sanitization.

import { Router, type Request, type Response } from 'express';
import * as templates from '../services/templates/index.js';
import * as settings from '../services/settings.js';
import { env } from '../config/env.js';
import { sendError } from '../middleware/errors.js';

const COMFYUI_URL = env.COMFYUI_URL;

const router = Router();

// Reject any asset path segment containing '..' so a crafted request can't
// traverse outside of ComfyUI's templates directory even if the upstream's
// own guard is absent.
function isSafeAssetPath(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('/')) return false;
  return true;
}

// Templates — always fetch fresh from ComfyUI.
// When no Comfy Org API key is configured, hide API-node workflows entirely
// so they don't appear anywhere in the UI (Explore, Studio, model-dep filters).
router.get('/templates', async (_req: Request, res: Response) => {
  try {
    await templates.loadTemplatesFromComfyUI(COMFYUI_URL);
  } catch {
    // will return cached or empty
  }
  const all = templates.getTemplates();
  const result = settings.isApiKeyConfigured()
    ? all
    : all.filter(t => t.openSource !== false);
  res.json(result);
});

router.get('/templates/:name', (req: Request, res: Response) => {
  const t = templates.getTemplate(req.params.name as string);
  if (!t) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  res.json(t);
});

// Proxy template assets (thumbnails, input/output images) from ComfyUI.
router.get('/template-asset/*', async (req: Request, res: Response) => {
  try {
    const assetPath = req.params[0] as string;
    if (!isSafeAssetPath(assetPath)) {
      res.status(400).end();
      return;
    }
    const url = `${COMFYUI_URL}/templates/${assetPath}`;
    const response = await fetch(url);
    if (!response.ok) {
      res.status(response.status).end();
      return;
    }
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).end();
  }
});

// Raw workflow JSON proxy for clients that want to inspect the template's
// underlying LiteGraph document.
router.get('/workflow/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const upstream = await fetch(
      `${COMFYUI_URL}/templates/${encodeURIComponent(name)}.json`
    );
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Workflow not found: ${name}` });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    sendError(res, err, 502, 'Cannot fetch workflow');
  }
});

export default router;
