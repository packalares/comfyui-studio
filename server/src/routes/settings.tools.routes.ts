// Settings for chat-side tool integrations (web_search, RAGFlow, default
// image template). Lives apart from `settings.routes.ts` so the parent file
// stays under the 250-line cap.
//
// Returns plain values for the URLs and the configured-flag for the
// RAGFlow API key — same convention the existing `/settings/chat` GET uses
// for non-secret fields, and the same convention `/settings/secret`
// uses for the secret part.

import { Router, type Request, type Response } from 'express';
import * as toolsSettings from '../services/settings.tools.js';

const router = Router();

router.get('/settings/tools', (_req: Request, res: Response) => {
  res.json({
    searxngUrl: toolsSettings.getSearxngUrl() ?? '',
    ragflowUrl: toolsSettings.getRagflowUrl() ?? '',
    ragflowApiKeyConfigured: toolsSettings.isRagflowApiKeyConfigured(),
    defaultImageTemplate: toolsSettings.getDefaultImageTemplate() ?? '',
  });
});

router.put('/settings/tools', (req: Request, res: Response) => {
  const body = req.body as {
    searxngUrl?: unknown;
    ragflowUrl?: unknown;
    ragflowApiKey?: unknown;
    defaultImageTemplate?: unknown;
  };
  if (typeof body.searxngUrl === 'string') {
    const trimmed = body.searxngUrl.trim();
    if (trimmed.length === 0) toolsSettings.clearSearxngUrl();
    else toolsSettings.setSearxngUrl(trimmed);
  }
  if (typeof body.ragflowUrl === 'string') {
    const trimmed = body.ragflowUrl.trim();
    if (trimmed.length === 0) toolsSettings.clearRagflowUrl();
    else toolsSettings.setRagflowUrl(trimmed);
  }
  if (typeof body.ragflowApiKey === 'string') {
    const trimmed = body.ragflowApiKey.trim();
    if (trimmed.length === 0) toolsSettings.clearRagflowApiKey();
    else toolsSettings.setRagflowApiKey(trimmed);
  }
  if (typeof body.defaultImageTemplate === 'string') {
    const trimmed = body.defaultImageTemplate.trim();
    if (trimmed.length === 0) toolsSettings.clearDefaultImageTemplate();
    else toolsSettings.setDefaultImageTemplate(trimmed);
  }
  res.json({
    searxngUrl: toolsSettings.getSearxngUrl() ?? '',
    ragflowUrl: toolsSettings.getRagflowUrl() ?? '',
    ragflowApiKeyConfigured: toolsSettings.isRagflowApiKeyConfigured(),
    defaultImageTemplate: toolsSettings.getDefaultImageTemplate() ?? '',
  });
});

// Probe a SearXNG URL without persisting it. Mirrors the chat / Ollama probe
// — emits `{ ok, error?, resultCount? }` so the Settings page can surface a
// failure inline before the user clicks Save.
router.get('/settings/tools/probe-searxng', async (req: Request, res: Response) => {
  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!raw) {
    res.status(400).json({ ok: false, error: 'url is required' });
    return;
  }
  const url = raw.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(
      `${url}/search?format=json&q=hello&pageno=1`,
      { headers: { Accept: 'application/json' }, signal: ctrl.signal },
    );
    if (!r.ok) {
      res.json({ ok: false, error: `upstream ${r.status} ${r.statusText}` });
      return;
    }
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('json')) {
      res.json({
        ok: false,
        error: 'instance returned HTML — enable JSON output (formats: [html, json] in settings.yml).',
      });
      return;
    }
    const payload = await r.json() as { results?: unknown };
    const count = Array.isArray(payload?.results) ? payload.results.length : 0;
    res.json({ ok: true, resultCount: count });
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
});

export default router;
