// Settings routes:
//   PUT    /settings/:key  — write secret | chat | tools
//   DELETE /settings/:key  — clear one named secret (other keys → 405)
//   POST   /settings/probe — validate an Ollama or SearXNG URL
//
// Reads for chat/tools live on GET /system; stored secret values never leave.

import { Router, type Request, type Response } from 'express';
import * as settings from '../services/settings/index.js';
import * as toolsSettings from '../services/settings/tools.js';
import * as mcpSettings from '../services/settings/mcp.js';
import { stripTrailingSlash } from '../lib/url.js';

const router = Router();

// ---- Secret handlers ----

const SECRET_HANDLERS = {
  apiKeyComfyOrg: { set: settings.setApiKey,       clear: settings.clearApiKey },
  hfToken:        { set: settings.setHfToken,      clear: settings.clearHfToken },
  civitaiToken:   { set: settings.setCivitaiToken, clear: settings.clearCivitaiToken },
  githubToken:    { set: settings.setGithubToken,  clear: settings.clearGithubToken },
  pexelsApiKey:   { set: settings.setPexelsApiKey, clear: settings.clearPexelsApiKey },
  studioMcpToken: {
    set: (v: string) => mcpSettings.setStudioMcpToken(v),
    clear: () => mcpSettings.setStudioMcpToken(null),
  },
} as const;
type SecretName = keyof typeof SECRET_HANDLERS;

const isSecretName = (s: unknown): s is SecretName =>
  typeof s === 'string' && s in SECRET_HANDLERS;

function clearSecretByName(name: SecretName): void {
  SECRET_HANDLERS[name].clear();
}

function putSecret(req: Request, res: Response): void {
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
}

// ---- Chat handlers ----

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

function putChat(req: Request, res: Response): void {
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
  // Advanced tunables — each is a positive number; null/undefined clears to default.
  // Getters validate, so a corrupt write can't break the chat path.
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
}

// ---- Tools handlers ----

function toolsSettingsResponse() {
  return {
    searxngUrl: toolsSettings.getSearxngUrl() ?? '',
    defaultImageTemplate: toolsSettings.getDefaultImageTemplate() ?? '',
    enabledMcpTools: toolsSettings.getEnabledMcpTools(),
  };
}

function putTools(req: Request, res: Response): void {
  const body = req.body as {
    searxngUrl?: unknown;
    defaultImageTemplate?: unknown;
    enabledMcpTools?: unknown;
  };
  if (body.enabledMcpTools !== undefined) {
    if (
      typeof body.enabledMcpTools !== 'object'
      || body.enabledMcpTools === null
      || Array.isArray(body.enabledMcpTools)
    ) {
      res.status(400).json({ error: '`enabledMcpTools` must be an object' });
      return;
    }
    const map = body.enabledMcpTools as Record<string, unknown>;
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== 'boolean') {
        res.status(400).json({ error: `enabledMcpTools["${k}"] must be boolean` });
        return;
      }
    }
    toolsSettings.setEnabledMcpTools(map as Record<string, boolean>);
  }
  if (typeof body.searxngUrl === 'string') {
    const trimmed = body.searxngUrl.trim();
    if (trimmed.length === 0) toolsSettings.clearSearxngUrl();
    else toolsSettings.setSearxngUrl(trimmed);
  }
  if (typeof body.defaultImageTemplate === 'string') {
    const trimmed = body.defaultImageTemplate.trim();
    if (trimmed.length === 0) toolsSettings.clearDefaultImageTemplate();
    else toolsSettings.setDefaultImageTemplate(trimmed);
  }
  res.json(toolsSettingsResponse());
}

// ---- Probe handler ----

type ProbeType = 'ollama' | 'searxng';
const PROBE_TYPES: readonly ProbeType[] = ['ollama', 'searxng'];

const SUB_PATH: Record<ProbeType, string> = {
  ollama: '/api/tags',
  searxng: '/search?format=json&q=hello&pageno=1',
};

const PROBE_TIMEOUT_MS = 4000;

async function runProbe(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { type?: unknown; url?: unknown };
  const type = body.type;
  if (typeof type !== 'string' || !PROBE_TYPES.includes(type as ProbeType)) {
    res.status(400).json({ ok: false, error: 'unknown probe type' });
    return;
  }
  const rawUrl = body.url;
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    res.status(400).json({ ok: false, error: 'url is required' });
    return;
  }
  // Parse the user's URL before appending the sub-path so error messages
  // don't leak the appended path back to the user.
  const cleaned = stripTrailingSlash(rawUrl.trim());
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    res.json({ ok: false, error: 'Invalid URL' });
    return;
  }

  const probeUrl = `${parsed.origin}${stripTrailingSlash(parsed.pathname)}${SUB_PATH[type as ProbeType]}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = type === 'searxng'
      ? { Accept: 'application/json' }
      : {};
    const r = await fetch(probeUrl, { headers, signal: ctrl.signal });
    if (!r.ok) {
      res.json({ ok: false, error: `upstream ${r.status} ${r.statusText}` });
      return;
    }
    if (type === 'searxng') {
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
      res.json({ ok: true, count });
      return;
    }
    // ollama
    const payload = await r.json() as { models?: unknown };
    const count = Array.isArray(payload?.models) ? payload.models.length : 0;
    res.json({ ok: true, count });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      res.json({ ok: false, error: 'timeout' });
      return;
    }
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Routes ----

router.put('/settings/:key', (req: Request, res: Response) => {
  const key = req.params.key;
  if (key === 'secret') return putSecret(req, res);
  if (key === 'chat') return putChat(req, res);
  if (key === 'tools') return putTools(req, res);
  res.status(404).json({ error: 'unknown settings key' });
});

router.delete('/settings/:key', (req: Request, res: Response) => {
  const key = req.params.key;
  if (key !== 'secret') {
    res.status(405).json({ error: 'DELETE only supported for secret' });
    return;
  }
  const name = String(req.query.name ?? '');
  if (!isSecretName(name)) {
    res.status(400).json({ error: 'unknown secret name' });
    return;
  }
  clearSecretByName(name);
  res.json({ configured: false });
});

router.post('/settings/probe', async (req: Request, res: Response) => {
  await runProbe(req, res);
});

export default router;
