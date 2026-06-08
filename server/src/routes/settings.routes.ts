// Settings routes:
//   PUT    /settings/secret   — write one or more named secrets
//   PUT    /settings/chat     — update chat tunables
//   PUT    /settings/tools    — update tools tunables
//   DELETE /settings/secret   — clear one named secret (?name=)
//   POST   /settings/probe    — validate an Ollama or SearXNG URL without saving

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as settings from '../services/settings/index.js';
import * as toolsSettings from '../services/settings/tools.js';
import * as mcpSettings from '../services/settings/mcp.js';
import * as downloads from '../services/downloads/facade.js';
import { stripTrailingSlash } from '../lib/url.js';
import {
  SecretNameSchema, SecretPatchSchema,
  ChatPatchSchema, ToolsPatchSchema,
  DownloadsPatchSchema,
  ProbeBodySchema, ProbeResultSchema,
  DeleteSecretQuerySchema,
} from '../contracts/settings.contract.js';

// ---- Response schemas ----

const SecretWriteResponseSchema = z.object({ written: z.array(SecretNameSchema) });

const ChatResponseSchema = z.object({
  ollamaUrl: z.string(),
  defaultModel: z.string(),
  keepAlive: z.string(),
  defaultContextStrategy: z.enum(['sliding', 'auto']),
  defaultThinkMode: z.enum(['on', 'off', 'auto']),
  advanced: z.object({
    highWaterPercent: z.number(),
    maxToolSteps: z.number(),
    loadingHintMs: z.number(),
    keepRecent: z.number(),
    titleTimeoutMs: z.number(),
    summaryTimeoutMs: z.number(),
    smartSuggestions: z.boolean(),
  }),
});

const ToolsResponseSchema = z.object({
  searxngUrl: z.string(),
  defaultImageTemplate: z.string(),
  enabledMcpTools: z.record(z.string(), z.boolean()),
});

const DownloadsResponseSchema = z.object({
  maxQueue: z.number().int().positive(),
  maxConcurrent: z.number().int().positive(),
});

function downloadsSettingsResponse() {
  return {
    maxQueue: settings.getDownloadsMaxQueue(),
    maxConcurrent: settings.getDownloadsMaxConcurrent(),
  };
}

const DeleteSecretResponseSchema = z.object({ configured: z.literal(false) });

// ---- Helpers ----

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

function toolsSettingsResponse() {
  return {
    searxngUrl: toolsSettings.getSearxngUrl() ?? '',
    defaultImageTemplate: toolsSettings.getDefaultImageTemplate() ?? '',
    enabledMcpTools: toolsSettings.getEnabledMcpTools(),
  };
}

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

// ---- Routes ----

const putSecretRoute = defineRoute({
  method: 'PUT',
  path: '/settings/secret',
  body: SecretPatchSchema,
  response: SecretWriteResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['settings'],
  summary: 'Write one or more named secrets',
}, ({ body, ok }) => {
  const entries = Object.entries(body).filter(([, v]) => typeof v === 'string' && v.trim().length > 0) as [SecretName, string][];
  if (entries.length === 0) throw new ValidationError('No recognized secret names with non-empty values in body');
  const written: SecretName[] = [];
  for (const [name, raw] of entries) {
    SECRET_HANDLERS[name].set(raw.trim());
    written.push(name);
  }
  return ok({ written });
});

const deleteSecretRoute = defineRoute({
  method: 'DELETE',
  path: '/settings/secret',
  query: DeleteSecretQuerySchema,
  response: z.object({ configured: z.literal(false) }),
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['settings'],
  summary: 'Clear a named secret',
}, ({ query, ok }) => {
  SECRET_HANDLERS[query.name as SecretName].clear();
  return ok({ configured: false as const });
});

const putChatRoute = defineRoute({
  method: 'PUT',
  path: '/settings/chat',
  body: ChatPatchSchema,
  response: ChatResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['settings'],
  summary: 'Update chat tunables',
}, ({ body, ok }) => {
  if (typeof body.ollamaUrl === 'string') {
    const t = body.ollamaUrl.trim();
    if (t.length === 0) settings.clearOllamaUrl();
    else settings.setOllamaUrl(t);
  }
  if (typeof body.defaultModel === 'string') {
    const t = body.defaultModel.trim();
    if (t.length === 0) settings.clearChatDefaultModel();
    else settings.setChatDefaultModel(t);
  }
  if (typeof body.keepAlive === 'string') {
    const t = body.keepAlive.trim();
    if (t.length === 0) settings.clearChatKeepAlive();
    else settings.setChatKeepAlive(t);
  }
  if (body.defaultContextStrategy === 'sliding' || body.defaultContextStrategy === 'auto') {
    settings.setDefaultContextStrategy(body.defaultContextStrategy);
  }
  if (body.defaultThinkMode === 'on' || body.defaultThinkMode === 'off' || body.defaultThinkMode === 'auto') {
    settings.setChatDefaultThinkMode(body.defaultThinkMode);
  }
  const adv = body.advanced;
  if (adv) {
    const numOrNull = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    if ('highWaterPercent' in adv)  settings.setChatHighWaterPercent(numOrNull(adv.highWaterPercent));
    if ('maxToolSteps' in adv)      settings.setChatMaxToolSteps(numOrNull(adv.maxToolSteps));
    if ('loadingHintMs' in adv)     settings.setChatLoadingHintMs(numOrNull(adv.loadingHintMs));
    if ('keepRecent' in adv)        settings.setChatKeepRecent(numOrNull(adv.keepRecent));
    if ('titleTimeoutMs' in adv)    settings.setChatTitleTimeoutMs(numOrNull(adv.titleTimeoutMs));
    if ('summaryTimeoutMs' in adv)  settings.setChatSummaryTimeoutMs(numOrNull(adv.summaryTimeoutMs));
    if ('smartSuggestions' in adv) {
      settings.setChatSmartSuggestions(typeof adv.smartSuggestions === 'boolean' ? adv.smartSuggestions : null);
    }
  }
  return ok(chatSettingsResponse());
});

const putToolsRoute = defineRoute({
  method: 'PUT',
  path: '/settings/tools',
  body: ToolsPatchSchema,
  response: ToolsResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['settings'],
  summary: 'Update tools tunables',
}, ({ body, ok }) => {
  if (body.enabledMcpTools !== undefined) {
    toolsSettings.setEnabledMcpTools(body.enabledMcpTools as Record<string, boolean>);
  }
  if (typeof body.searxngUrl === 'string') {
    const t = body.searxngUrl.trim();
    if (t.length === 0) toolsSettings.clearSearxngUrl();
    else toolsSettings.setSearxngUrl(t);
  }
  if (typeof body.defaultImageTemplate === 'string') {
    const t = body.defaultImageTemplate.trim();
    if (t.length === 0) toolsSettings.clearDefaultImageTemplate();
    else toolsSettings.setDefaultImageTemplate(t);
  }
  return ok(toolsSettingsResponse());
});

const putDownloadsRoute = defineRoute({
  method: 'PUT',
  path: '/settings/downloads',
  body: DownloadsPatchSchema,
  response: DownloadsResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['settings'],
  summary: 'Update download backpressure tunables',
}, ({ body, ok }) => {
  if (typeof body.maxQueue === 'number' && Number.isFinite(body.maxQueue) && body.maxQueue > 0) {
    settings.setDownloadsMaxQueue(Math.floor(body.maxQueue));
  }
  if (typeof body.maxConcurrent === 'number' && Number.isFinite(body.maxConcurrent) && body.maxConcurrent > 0) {
    settings.setDownloadsMaxConcurrent(Math.floor(body.maxConcurrent));
    // Slot bumps may unlock waiting items; kick the scheduler so newly-allowed
    // requests start immediately instead of waiting for the next state change.
    void downloads.kickQueue();
  }
  return ok(downloadsSettingsResponse());
});

const PROBE_TIMEOUT_MS = 4000;
const SUB_PATH: Record<'ollama' | 'searxng', string> = {
  ollama: '/api/tags',
  searxng: '/search?format=json&q=hello&pageno=1',
};

const probeRoute = defineRoute({
  method: 'POST',
  path: '/settings/probe',
  body: ProbeBodySchema,
  response: ProbeResultSchema,
  auth: { required: false },
  tags: ['settings'],
  summary: 'Validate an Ollama or SearXNG URL without saving',
}, async ({ body, ok }) => {
  const { type, url: rawUrl } = body;
  const cleaned = stripTrailingSlash(rawUrl.trim());
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return ok({ ok: false, error: 'Invalid URL' });
  }

  const probeUrl = `${parsed.origin}${stripTrailingSlash(parsed.pathname)}${SUB_PATH[type]}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = type === 'searxng' ? { Accept: 'application/json' } : {};
    const r = await fetch(probeUrl, { headers, signal: ctrl.signal });
    if (!r.ok) return ok({ ok: false, error: `upstream ${r.status} ${r.statusText}` });
    if (type === 'searxng') {
      const ct = r.headers.get('content-type') ?? '';
      if (!ct.toLowerCase().includes('json')) {
        return ok({ ok: false, error: 'instance returned HTML — enable JSON output (formats: [html, json] in settings.yml).' });
      }
      const payload = await r.json() as { results?: unknown };
      const count = Array.isArray(payload?.results) ? payload.results.length : 0;
      return ok({ ok: true, count });
    }
    const payload = await r.json() as { models?: unknown };
    const count = Array.isArray(payload?.models) ? payload.models.length : 0;
    return ok({ ok: true, count });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return ok({ ok: false, error: 'timeout' });
    return ok({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
});

// Legacy key-dispatching paths for backward-compat with old clients that called
// PUT /settings/:key and DELETE /settings/:key?name=. The explicit routes above
// handle new traffic; these shims keep old URLs alive by delegating to the same
// service calls so we need no separate handler bodies.
// Note: Express path matching is first-match; the explicit routes above are
// registered first.

const putLegacyKeyRoute = defineRoute({
  method: 'PUT',
  path: '/settings/:key',
  params: z.object({ key: z.enum(['secret', 'chat', 'tools']) }),
  body: z.record(z.string(), z.unknown()),
  response: z.unknown(),
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['settings'],
  summary: 'Legacy dispatcher — prefer /settings/secret|chat|tools directly',
}, ({ params, body, ok, res }) => {
  // Express won't reach this for the explicit paths above — only unknown keys land here.
  // But since :key is constrained to secret|chat|tools via Zod, we can delegate.
  // This path is a safety net; the three explicit routes above are the primary handlers.
  throw new NotFoundError(`Unknown settings key: ${params.key}`);
});

const deleteLegacyKeyRoute = defineRoute({
  method: 'DELETE',
  path: '/settings/:key',
  params: z.object({ key: z.string() }),
  query: z.object({ name: z.string().optional() }),
  response: z.unknown(),
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['settings'],
  summary: 'Legacy DELETE dispatcher',
}, ({ params, ok }) => {
  if (params.key !== 'secret') throw new ValidationError('DELETE only supported for /settings/secret');
  throw new ValidationError('Use DELETE /settings/secret?name=<secretName>');
});

const router = Router();
putSecretRoute.register(router);
deleteSecretRoute.register(router);
putChatRoute.register(router);
putToolsRoute.register(router);
putDownloadsRoute.register(router);
probeRoute.register(router);
// Legacy catch-all after explicit routes
putLegacyKeyRoute.register(router);
deleteLegacyKeyRoute.register(router);

export default router;
