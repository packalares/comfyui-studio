// Server-side configured secrets: Comfy Org API key + HuggingFace token.
//
// GET returns only a `{ configured }` flag so the secret itself never leaves
// the server. PUT writes the trimmed value via the settings service, DELETE
// clears it. No value is ever logged or echoed.

import { Router, type Request, type Response } from 'express';
import * as settings from '../services/settings.js';

const router = Router();

// ---- Unified secret store ----
// Status flags (`apiKeyConfigured`, `hfTokenConfigured`, …) live on
// `GET /api/system`. There is no GET here — values never leave the server.
// PUT accepts a name→value map (1+ pairs at once, only dirty ones sent by the
// UI). DELETE clears one named secret per call.
const SECRET_HANDLERS = {
  apiKeyComfyOrg: { set: settings.setApiKey,       clear: settings.clearApiKey },
  hfToken:        { set: settings.setHfToken,      clear: settings.clearHfToken },
  civitaiToken:   { set: settings.setCivitaiToken, clear: settings.clearCivitaiToken },
  githubToken:    { set: settings.setGithubToken,  clear: settings.clearGithubToken },
  pexelsApiKey:   { set: settings.setPexelsApiKey, clear: settings.clearPexelsApiKey },
} as const;
type SecretName = keyof typeof SECRET_HANDLERS;
const isSecretName = (s: unknown): s is SecretName =>
  typeof s === 'string' && s in SECRET_HANDLERS;

router.put('/settings/secret', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const entries = Object.entries(body).filter(([k]) => isSecretName(k));
  if (entries.length === 0) {
    res.status(400).json({ error: 'no recognized secret names in body' });
    return;
  }
  const written: SecretName[] = [];
  for (const [name, raw] of entries) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      res.status(400).json({ error: `value for "${name}" must be a non-empty string` });
      return;
    }
    SECRET_HANDLERS[name as SecretName].set(raw.trim());
    written.push(name as SecretName);
  }
  res.json({ written });
});

router.delete('/settings/secret', (req: Request, res: Response) => {
  const name = String(req.query.name ?? '');
  if (!isSecretName(name)) {
    res.status(400).json({ error: 'unknown secret name' });
    return;
  }
  SECRET_HANDLERS[name].clear();
  res.json({ configured: false });
});

// ---- Chat / LLM (Ollama) settings ----
//
// Returned as plain values — these aren't secrets, they're addresses /
// preferences for the local LLM backend. The url has a baked-in default
// (`http://localhost:11434`) so /api/system + GET here always render
// something sensible even on a brand-new install.

function chatSettingsResponse() {
  return {
    ollamaUrl: settings.getOllamaUrl(),
    defaultModel: settings.getChatDefaultModel() ?? '',
    keepAlive: settings.getChatKeepAlive(),
    defaultContextStrategy: settings.getDefaultContextStrategy(),
    defaultThinkMode: settings.getChatDefaultThinkMode(),
    advanced: {
      highWaterPercent: settings.getChatHighWaterPercent(),
      maxToolSteps: settings.getChatMaxToolSteps(),
      loadingHintMs: settings.getChatLoadingHintMs(),
      keepRecent: settings.getChatKeepRecent(),
      titleTimeoutMs: settings.getChatTitleTimeoutMs(),
      summaryTimeoutMs: settings.getChatSummaryTimeoutMs(),
      smartSuggestions: settings.getChatSmartSuggestions(),
    },
  };
}

router.get('/settings/chat', (_req: Request, res: Response) => {
  res.json(chatSettingsResponse());
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
    defaultThinkMode?: unknown;
    advanced?: {
      highWaterPercent?: unknown;
      maxToolSteps?: unknown;
      loadingHintMs?: unknown;
      keepRecent?: unknown;
      titleTimeoutMs?: unknown;
      summaryTimeoutMs?: unknown;
      smartSuggestions?: unknown;
    };
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
    || body.defaultContextStrategy === 'auto'
  ) {
    settings.setDefaultContextStrategy(body.defaultContextStrategy);
  }
  if (
    body.defaultThinkMode === 'on'
    || body.defaultThinkMode === 'off'
    || body.defaultThinkMode === 'auto'
  ) {
    settings.setChatDefaultThinkMode(body.defaultThinkMode);
  }
  // Advanced tunables — each is a positive number; null/undefined clears
  // back to the documented default. All getters validate so a corrupt
  // write can't break the chat path.
  const adv = body.advanced;
  if (adv && typeof adv === 'object') {
    const numOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    if ('highWaterPercent' in adv)     settings.setChatHighWaterPercent(numOrNull(adv.highWaterPercent));
    if ('maxToolSteps' in adv)         settings.setChatMaxToolSteps(numOrNull(adv.maxToolSteps));
    if ('loadingHintMs' in adv)        settings.setChatLoadingHintMs(numOrNull(adv.loadingHintMs));
    if ('keepRecent' in adv)           settings.setChatKeepRecent(numOrNull(adv.keepRecent));
    if ('titleTimeoutMs' in adv)       settings.setChatTitleTimeoutMs(numOrNull(adv.titleTimeoutMs));
    if ('summaryTimeoutMs' in adv)     settings.setChatSummaryTimeoutMs(numOrNull(adv.summaryTimeoutMs));
    if ('smartSuggestions' in adv) {
      const v = adv.smartSuggestions;
      settings.setChatSmartSuggestions(typeof v === 'boolean' ? v : null);
    }
  }
  res.json(chatSettingsResponse());
});

export default router;
