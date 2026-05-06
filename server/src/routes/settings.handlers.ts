// Per-key write handlers used by the consolidated `PUT /settings/:key`
// dispatcher. Split out so `settings.routes.ts` stays focused on the wiring
// and the file-size cap holds. Each branch keeps its own body shape because
// the three groups (secret / chat / tools) accept meaningfully different
// payloads — the consolidation win is in route count, not body uniformity.

import type { Request, Response } from 'express';
import * as settings from '../services/settings.js';
import * as toolsSettings from '../services/settings.tools.js';
import * as mcpSettings from '../services/settings.mcp.js';

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

export const isSecretName = (s: unknown): s is SecretName =>
  typeof s === 'string' && s in SECRET_HANDLERS;

export function clearSecretByName(name: SecretName): void {
  SECRET_HANDLERS[name].clear();
}

export function putSecret(req: Request, res: Response): void {
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

export function putChat(req: Request, res: Response): void {
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
}

function toolsSettingsResponse() {
  return {
    searxngUrl: toolsSettings.getSearxngUrl() ?? '',
    ragflowUrl: toolsSettings.getRagflowUrl() ?? '',
    ragflowApiKeyConfigured: toolsSettings.isRagflowApiKeyConfigured(),
    defaultImageTemplate: toolsSettings.getDefaultImageTemplate() ?? '',
    enabledMcpTools: toolsSettings.getEnabledMcpTools(),
  };
}

export function putTools(req: Request, res: Response): void {
  const body = req.body as {
    searxngUrl?: unknown;
    ragflowUrl?: unknown;
    ragflowApiKey?: unknown;
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
  res.json(toolsSettingsResponse());
}
