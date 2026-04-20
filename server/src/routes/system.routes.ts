// System + queue + active-downloads snapshot.
//
// `/system` is the dashboard aggregator: device stats, queue counters, and the
// most recent gallery rows. Each source is fetched independently so a partial
// outage still returns whatever is available.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';
import { getAllDownloads } from '../services/downloads.js';

const router = Router();

// Combined system info: device stats + queue + recent gallery.
router.get('/system', async (_req: Request, res: Response) => {
  const [statsResult, queueResult, galleryResult] = await Promise.allSettled([
    comfyui.getSystemStats(),
    comfyui.getQueue(),
    comfyui.getGalleryItems(),
  ]);

  const stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
  const queue = queueResult.status === 'fulfilled' ? queueResult.value : null;
  const gallery = galleryResult.status === 'fulfilled' ? galleryResult.value : [];

  if (!stats && !queue) {
    res.status(502).json({ error: 'Cannot reach ComfyUI' });
    return;
  }

  res.json({
    ...(stats as object || {}),
    queue,
    gallery: {
      total: gallery.length,
      recent: gallery.slice(0, 8),
    },
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
