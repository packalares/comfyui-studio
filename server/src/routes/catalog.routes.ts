// Model catalog routes. The merged view is the single source of truth the UI
// consumes; the refresh endpoint is used as a just-in-time size-lookup trigger
// before the frontend shows a download progress bar.

import { Router, type Request, type Response } from 'express';
import * as catalog from '../services/catalog.js';

const router = Router();

// Merged view: catalog + launcher disk scan joined with install state.
router.get('/models/catalog', async (_req: Request, res: Response) => {
  res.json(await catalog.getMergedModels());
});

// Force-refresh size info for a specific model (or many). Used when the user
// clicks Download so the size is fresh before the progress bar appears.
router.post('/models/catalog/refresh-size', async (req: Request, res: Response) => {
  const { filename, filenames } = (req.body || {}) as {
    filename?: string;
    filenames?: string[];
  };
  await catalog.seedFromComfyUI();
  if (filename) {
    const m = await catalog.refreshSize(filename, { force: true });
    res.json(m);
    return;
  }
  if (Array.isArray(filenames)) {
    await catalog.refreshMany(filenames, { force: true, concurrency: 8 });
    res.json({ ok: true });
    return;
  }
  res.status(400).json({ error: 'provide `filename` or `filenames`' });
});

export default router;
