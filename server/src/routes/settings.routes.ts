// Server-side configured secrets: Comfy Org API key + HuggingFace token.
//
// GET returns only a `{ configured }` flag so the secret itself never leaves
// the server. PUT writes the trimmed value via the settings service, DELETE
// clears it. No value is ever logged or echoed.

import { Router, type Request, type Response } from 'express';
import * as settings from '../services/settings.js';

const router = Router();

// ---- Comfy Org API key (stored server-side, never returned to client) ----
// Status (`configured` flag) is exposed via `GET /api/system` — there's no
// separate GET here. Only writes remain.
router.put('/settings/api-key', (req: Request, res: Response) => {
  const { apiKey } = req.body as { apiKey?: unknown };
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    res.status(400).json({ error: 'apiKey must be a non-empty string' });
    return;
  }
  settings.setApiKey(apiKey.trim());
  res.json({ configured: true });
});

router.delete('/settings/api-key', (_req: Request, res: Response) => {
  settings.clearApiKey();
  res.json({ configured: false });
});

// ---- HuggingFace token (for gated models + private HEAD/GET requests) ----
// Status flag is carried on `GET /api/system`. Only writes remain.
router.put('/settings/hf-token', (req: Request, res: Response) => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || token.trim().length === 0) {
    res.status(400).json({ error: 'token must be a non-empty string' });
    return;
  }
  settings.setHfToken(token.trim());
  res.json({ configured: true });
});

router.delete('/settings/hf-token', (_req: Request, res: Response) => {
  settings.clearHfToken();
  res.json({ configured: false });
});

// ---- CivitAI token (for authenticated civitai.com downloads + private content) ----
// Status flag is carried on `GET /api/system`. Only writes remain.
router.put('/settings/civitai-token', (req: Request, res: Response) => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || token.trim().length === 0) {
    res.status(400).json({ error: 'token must be a non-empty string' });
    return;
  }
  settings.setCivitaiToken(token.trim());
  res.json({ configured: true });
});

router.delete('/settings/civitai-token', (_req: Request, res: Response) => {
  settings.clearCivitaiToken();
  res.json({ configured: false });
});

// ---- GitHub token (for github-release downloads + REST API auth) ----
// Status flag is carried on `GET /api/system`. Only writes remain.
router.put('/settings/github-token', (req: Request, res: Response) => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || token.trim().length === 0) {
    res.status(400).json({ error: 'token must be a non-empty string' });
    return;
  }
  settings.setGithubToken(token.trim());
  res.json({ configured: true });
});

router.delete('/settings/github-token', (_req: Request, res: Response) => {
  settings.clearGithubToken();
  res.json({ configured: false });
});

// ---- Pexels API key (stock-photo fallback for audio thumbnails) ----
// Unset → audio rows without embedded cover art skip straight to Picsum.
// Status flag is carried on `GET /api/system`. Only writes remain.
router.put('/settings/pexels-api-key', (req: Request, res: Response) => {
  const { apiKey } = req.body as { apiKey?: unknown };
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    res.status(400).json({ error: 'apiKey must be a non-empty string' });
    return;
  }
  settings.setPexelsApiKey(apiKey.trim());
  res.json({ configured: true });
});

router.delete('/settings/pexels-api-key', (_req: Request, res: Response) => {
  settings.clearPexelsApiKey();
  res.json({ configured: false });
});

// ---- Chat / LLM (Ollama) settings ----
//
// Returned as plain values — these aren't secrets, they're addresses /
// preferences for the local LLM backend. The url has a baked-in default
// (`http://localhost:11434`) so /api/system + GET here always render
// something sensible even on a brand-new install.

router.get('/settings/chat', (_req: Request, res: Response) => {
  res.json({
    ollamaUrl: settings.getOllamaUrl(),
    defaultModel: settings.getChatDefaultModel() ?? '',
    keepAlive: settings.getChatKeepAlive(),
    defaultContextStrategy: settings.getDefaultContextStrategy(),
  });
});

// Probe an Ollama URL without persisting it — used by the Settings Chat card
// to validate the user's input before saving. We hit `/api/tags` because it's
// the cheapest endpoint Ollama exposes (just lists installed models).
router.post('/settings/chat/probe', async (req: Request, res: Response) => {
  const body = req.body as { ollamaUrl?: unknown };
  const raw = typeof body.ollamaUrl === 'string' ? body.ollamaUrl.trim() : '';
  if (!raw) { res.status(400).json({ ok: false, error: 'ollamaUrl is required' }); return; }
  // Strip a trailing slash so we don't end up with `//api/tags`.
  const url = raw.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
    if (!r.ok) {
      res.json({ ok: false, error: `upstream ${r.status} ${r.statusText}` });
      return;
    }
    const payload = await r.json() as { models?: unknown };
    const count = Array.isArray(payload?.models) ? payload.models.length : 0;
    res.json({ ok: true, modelCount: count });
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
});

router.put('/settings/chat', (req: Request, res: Response) => {
  const body = req.body as {
    ollamaUrl?: unknown;
    defaultModel?: unknown;
    keepAlive?: unknown;
    defaultContextStrategy?: unknown;
  };
  if (typeof body.ollamaUrl === 'string') {
    const trimmed = body.ollamaUrl.trim();
    if (trimmed.length === 0) settings.clearOllamaUrl();
    else settings.setOllamaUrl(trimmed);
  }
  if (typeof body.defaultModel === 'string') {
    const trimmed = body.defaultModel.trim();
    if (trimmed.length === 0) settings.clearChatDefaultModel();
    else settings.setChatDefaultModel(trimmed);
  }
  if (typeof body.keepAlive === 'string') {
    const trimmed = body.keepAlive.trim();
    if (trimmed.length === 0) settings.clearChatKeepAlive();
    else settings.setChatKeepAlive(trimmed);
  }
  if (
    body.defaultContextStrategy === 'sliding'
    || body.defaultContextStrategy === 'summarize'
    || body.defaultContextStrategy === 'manual'
  ) {
    settings.setDefaultContextStrategy(body.defaultContextStrategy);
  }
  res.json({
    ollamaUrl: settings.getOllamaUrl(),
    defaultModel: settings.getChatDefaultModel() ?? '',
    keepAlive: settings.getChatKeepAlive(),
    defaultContextStrategy: settings.getDefaultContextStrategy(),
  });
});

export default router;
