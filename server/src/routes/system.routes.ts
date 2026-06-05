// GET /api/system — dashboard aggregator: device stats, queue, chat config,
// personality summary, gallery snapshot, and network config in one round-trip.
//
// TODO Wave 4: split into /api/system/stats, /api/system/queue, /api/system/chat, etc.
// Each source is settled independently so a partial ComfyUI outage still returns
// the settings/gallery/personality slices.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { SystemResponseSchema } from '../contracts/system.contract.js';
import * as comfyui from '../services/comfyui/api.js';
import * as gallery from '../services/gallery/index.js';
import * as catalog from '../services/catalog/index.js';
import * as plugins from '../services/plugins/index.js';
import * as settings from '../services/settings/index.js';
import * as toolsSettings from '../services/settings/tools.js';
import { getStudioMcpStatus } from '../services/settings/mcp.js';
import { getMcpToolListings } from '../services/mcp/server/toolRegistry.js';
import { listAvailableTools } from '../services/chat/tools/index.js';
import { getSuggestions as getChatSuggestions } from '../services/chat/promptsLoader.js';
import { getNetworkConfig } from '../services/settings/network.js';
import * as networkChecker from '../services/networkChecker.js';
import { getPersonalitySummary } from '../services/chat/personality.js';
import { env } from '../config/env.js';

const systemRoute = defineRoute({
  method: 'GET',
  path: '/system',
  response: SystemResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['system'],
  summary: 'Dashboard aggregate: stats, queue, chat config, personality, gallery',
}, async (ctx) => {
  const [statsResult, queueResult, galleryResult, toolsResult, modelsResult] = await Promise.allSettled([
    comfyui.getSystemStats(),
    comfyui.getQueue(),
    gallery.listPaginated({}, 1, 8),
    listAvailableTools(),
    catalog.getMergedModels(),
  ]);

  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
  const queue = queueResult.status === 'fulfilled' ? queueResult.value : null;
  const galleryPage = galleryResult.status === 'fulfilled'
    ? galleryResult.value
    : { items: [], total: 0 };
  const availableTools = toolsResult.status === 'fulfilled' ? toolsResult.value : [];
  const mergedModels = modelsResult.status === 'fulfilled' ? modelsResult.value : null;

  const modelsInstalled = mergedModels !== null
    ? mergedModels.filter((m) => m.installed).length
    : null;
  let pluginsInstalled: number | null = null;
  let pluginHistory: unknown[] = [];
  try { pluginsInstalled = plugins.cache.getAllPlugins(false).filter((p) => p.installed).length; } catch { /* cold cache */ }
  try { pluginHistory = plugins.history.getHistory(20); } catch { /* cold cache */ }

  const lastReach = networkChecker.getLastResult();
  if (!lastReach) networkChecker.triggerCheck();
  const network = getNetworkConfig(
    lastReach
      ? Object.fromEntries(
          Object.entries(lastReach).map(([k, v]) => [k, { accessible: v.accessible, latencyMs: v.latencyMs }]),
        )
      : null,
  );

  const chat = {
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
    tools: {
      searxngUrl: toolsSettings.getSearxngUrl() ?? '',
      defaultImageTemplate: toolsSettings.getDefaultImageTemplate() ?? '',
      enabledMcpTools: toolsSettings.getEnabledMcpTools(),
      mcpToolListings: getMcpToolListings(),
      studioMcp: getStudioMcpStatus(),
      availableTools,
    },
    suggestions: getChatSuggestions(),
  };

  const personality = getPersonalitySummary();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ctx.ok({
    ...(stats as object || {}),
    queue,
    comfyuiConnected: stats !== null || queue !== null,
    network,
    chat,
    personality,
    gallery: {
      total: galleryPage.total,
      recent: galleryPage.items,
    },
    summary: { modelsInstalled, pluginsInstalled, pluginHistory },
    apiKeyConfigured: settings.isApiKeyConfigured(),
    hfTokenConfigured: settings.isHfTokenConfigured(),
    civitaiTokenConfigured: settings.isCivitaiTokenConfigured(),
    githubTokenConfigured: settings.isGithubTokenConfigured(),
    pexelsApiKeyConfigured: settings.isPexelsApiKeyConfigured(),
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
  } as unknown as z.infer<typeof SystemResponseSchema>);
});

const router = Router();
systemRoute.register(router);

export default router;
