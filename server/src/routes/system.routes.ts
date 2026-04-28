// System + queue + active-downloads snapshot.
//
// `/system` is the dashboard aggregator: device stats, queue counters, and the
// most recent gallery rows. Each source is fetched independently so a partial
// outage still returns whatever is available.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';
import * as gallery from '../services/gallery.service.js';
import * as settings from '../services/settings.js';
import { getAllDownloads } from '../services/downloads.js';
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

  if (!stats && !queue) {
    res.status(502).json({ error: 'Cannot reach ComfyUI' });
    return;
  }

  res.json({
    ...(stats as object || {}),
    queue,
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

// Queue status — resilient: returns zeros if ComfyUI is unreachable.
router.get('/queue', async (_req: Request, res: Response) => {
  try {
    const queue = await comfyui.getQueue();
    res.json(queue);
  } catch {
    res.json({ queue_running: 0, queue_pending: 0 });
  }
});

// Current in-progress downloads (fallback; WS snapshot on connect is primary).
router.get('/downloads', (_req: Request, res: Response) => {
  res.json(getAllDownloads());
});

export default router;
