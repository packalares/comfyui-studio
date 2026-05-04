// Ollama model browser endpoints.
//
// `/installed` proxies `GET /api/tags`; `/info/:name` proxies
// `GET /api/show?name=...`. Pull/delete go through Ollama's `/api/pull`
// and `/api/delete` (DELETE method, JSON body `{ name }`). Library +
// HuggingFace search are server-side aggregations cached separately.

import { Router, type Request, type Response } from 'express';
import * as settings from '../services/settings.js';
import { env } from '../config/env.js';
import { getOllamaLibrary, refreshOllamaLibrary } from '../services/chat/ollamaLibrary.js';
import { getOllamaTags } from '../services/chat/ollamaTags.js';
import { startPull, cancelPull } from '../services/chat/ollamaPull.js';

const router = Router();

const HF_TIMEOUT_MS = 8000;

router.get('/chat/models', async (_req: Request, res: Response) => {
  try {
    const baseUrl = settings.getOllamaUrl();
    const r = await fetch(`${baseUrl}/api/tags`);
    if (!r.ok) { res.status(502).json({ error: `upstream ${r.status}` }); return; }
    const body = await r.json();
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/chat/models/info/:name', async (req: Request, res: Response) => {
  try {
    const name = typeof req.params.name === 'string' ? req.params.name : '';
    const baseUrl = settings.getOllamaUrl();
    const r = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) { res.status(502).json({ error: `upstream ${r.status}` }); return; }
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/chat/models/pull', (req: Request, res: Response) => {
  const body = req.body as { name?: unknown };
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const result = startPull(body.name.trim());
  res.json(result);
});

router.post('/chat/models/pull/cancel', (req: Request, res: Response) => {
  const body = req.body as { name?: unknown };
  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  res.json({ cancelled: cancelPull(body.name.trim()) });
});

router.delete('/chat/models/:name', async (req: Request, res: Response) => {
  try {
    const name = typeof req.params.name === 'string' ? req.params.name : '';
    const baseUrl = settings.getOllamaUrl();
    const r = await fetch(`${baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) { res.status(502).json({ error: `upstream ${r.status}` }); return; }
    res.json({ deleted: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/chat/models/library', async (req: Request, res: Response) => {
  try {
    // Optional `q` filters by case-insensitive substring across name/title/
    // description. `page` is 1-indexed; `pageSize` is clamped to 200 in the
    // service. Defaults preserve back-compat for callers that just GET the
    // bare endpoint and expect every row.
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 200);
    const result = await getOllamaLibrary({
      q,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 200,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Force-rescrape upstream and overwrite the `ollama_library` table. The UI's
// Refresh button hits this. POST (not GET) because the call has a side
// effect (DB rewrite) and is rate-limited indirectly by the in-flight
// dedupe inside the service.
router.post('/chat/models/library/refresh', async (_req: Request, res: Response) => {
  try {
    const outcome = await refreshOllamaLibrary();
    res.json(outcome);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Per-model tag list — scraped lazily from
// `https://ollama.com/library/<name>/tags`. Cached for 1h server-side; the
// UI lazy-fetches on each dropdown open without its own cache.
router.get('/chat/models/library/:name/tags', async (req: Request, res: Response) => {
  const name = typeof req.params.name === 'string' ? req.params.name.trim() : '';
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }
  try {
    const tags = await getOllamaTags(name);
    res.json({ tags });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface HfApiModel {
  id?: unknown;
  modelId?: unknown;
  downloads?: unknown;
  likes?: unknown;
  lastModified?: unknown;
  pipeline_tag?: unknown;
  tags?: unknown;
}

router.get('/chat/models/search-hf', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) { res.json({ items: [] }); return; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HF_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = settings.getHfToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    // Honor the configurable HF endpoint (mirror) when present; fall back to
     // the canonical host. Matches the rest of the HF-touching code paths.
    const hfBase = (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
    const url = `${hfBase}/api/models?search=${encodeURIComponent(q)}&filter=gguf&limit=25`;
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) { res.status(502).json({ error: `upstream ${r.status}` }); return; }
    const body = await r.json() as unknown;
    const list = Array.isArray(body) ? (body as HfApiModel[]) : [];
    const items = list.map((m) => ({
      id: typeof m.id === 'string' ? m.id : (typeof m.modelId === 'string' ? m.modelId : ''),
      downloads: typeof m.downloads === 'number' ? m.downloads : null,
      likes: typeof m.likes === 'number' ? m.likes : null,
      lastModified: typeof m.lastModified === 'string' ? m.lastModified : null,
      pipeline_tag: typeof m.pipeline_tag === 'string' ? m.pipeline_tag : null,
      tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [],
    })).filter(m => m.id.length > 0);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
});

export default router;
