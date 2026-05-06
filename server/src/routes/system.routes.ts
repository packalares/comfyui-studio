// `/system` is the dashboard aggregator: device stats, queue counters, and the
// most recent gallery rows. Each source is fetched independently so a partial
// outage still returns whatever is available.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';
import * as gallery from '../services/gallery.service.js';
import * as settings from '../services/settings.js';
import * as toolsSettings from '../services/settings.tools.js';
import { getStudioMcpStatus } from '../services/settings.mcp.js';
import { getMcpToolListings } from '../services/mcp/server/toolRegistry.js';
import * as systemFacade from '../services/systemLauncher/system.service.js';
import * as networkChecker from '../services/systemLauncher/networkChecker/service.js';
import { env } from '../config/env.js';

const router = Router();

// Combined system info: device stats + queue + recent gallery.
//
// Gallery count + recent come from the persistent sqlite `gallery` table
// (via gallery.service.listPaginated) — NOT from ComfyUI's in-RAM history
// buffer. ComfyUI's history is volatile and session-scoped; the dashboard
// needs the same authoritative count that the Gallery page shows.
router.get('/system', async (_req: Request, res: Response) => {
  const [statsResult, queueResult, galleryResult] = await Promise.allSettled([
    comfyui.getSystemStats(),
    comfyui.getQueue(),
    gallery.listPaginated({}, 1, 8),
  ]);

  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
  const queue = queueResult.status === 'fulfilled' ? queueResult.value : null;
  const galleryPage = galleryResult.status === 'fulfilled'
    ? galleryResult.value
    : { items: [], total: 0 };

  // Network config + cached reachability snapshot — used to live behind the
  // standalone `GET /system/network-config` endpoint; folded in here so the
  // dashboard does one trip. Kicks a background probe on first boot when the
  // checker has never run, so subsequent calls surface real reachability.
  const lastReach = networkChecker.getLastResult();
  if (!lastReach) networkChecker.triggerCheck();
  const network = systemFacade.getNetworkConfig(
    lastReach
      ? Object.fromEntries(
          Object.entries(lastReach).map(([k, v]) => [k, { accessible: v.accessible, latencyMs: v.latencyMs }]),
        )
      : null,
  );

  // Always 200, even when ComfyUI is unreachable — gallery / secrets /
  // uploadMaxBytes are independent of ComfyUI and useful on first paint
  // (e.g. so the Navbar pill can flip to "Start ComfyUI" without waiting
  // for the WS launcher-status event). `comfyuiConnected` lets the UI
  // decide whether to trust the stats/queue fields below.
  // Chat / tools settings folded in so the dashboard payload carries every
  // user-facing config the Settings page needs. Mirrors the field lists from
  // the former `GET /settings/chat` + `GET /settings/tools` handlers; tools
  // sit under `chat.tools` since they're chat-LLM-only integrations.
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
      ragflowUrl: toolsSettings.getRagflowUrl() ?? '',
      ragflowApiKeyConfigured: toolsSettings.isRagflowApiKeyConfigured(),
      defaultImageTemplate: toolsSettings.getDefaultImageTemplate() ?? '',
      enabledMcpTools: toolsSettings.getEnabledMcpTools(),
      mcpToolListings: getMcpToolListings(),
      studioMcp: getStudioMcpStatus(),
    },
  };

  res.json({
    ...(stats as object || {}),
    queue,
    comfyuiConnected: stats !== null || queue !== null,
    network,
    chat,
    gallery: {
      total: galleryPage.total,
      recent: galleryPage.items,
    },
    apiKeyConfigured: settings.isApiKeyConfigured(),
    hfTokenConfigured: settings.isHfTokenConfigured(),
    civitaiTokenConfigured: settings.isCivitaiTokenConfigured(),
    githubTokenConfigured: settings.isGithubTokenConfigured(),
    pexelsApiKeyConfigured: settings.isPexelsApiKeyConfigured(),
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
  });
});

export default router;
