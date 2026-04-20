// Essential-models routes. Ported from launcher's EssentialModelsController.
// Mount BEFORE the launcher catch-all in `routes/index.ts`.

import { Router, type Request, type Response } from 'express';
import * as essential from '../services/essentialModels/essentialModels.service.js';
import * as settings from '../services/settings.js';
import { getTaskProgress } from '../services/downloadController/downloadController.service.js';
import { trackDownload, stopTracking } from '../services/downloads.js';
import { sendError } from '../middleware/errors.js';

const router = Router();

const ESSENTIAL_PATHS = {
  list: ['/models/essential', '/launcher/models/essential'],
  start: ['/models/download-essential', '/launcher/models/download-essential'],
  status: ['/models/essential-status', '/launcher/models/essential-status'],
  progress: ['/models/essential-progress/:id', '/launcher/models/essential-progress/:id'],
  cancel: ['/models/cancel-essential', '/launcher/models/cancel-essential'],
};

router.get(ESSENTIAL_PATHS.list, (_req: Request, res: Response) => {
  res.json(essential.listEssentialModels());
});

router.post(ESSENTIAL_PATHS.start, async (req: Request, res: Response) => {
  try {
    const { source = 'hf' } = (req.body || {}) as { source?: string };
    const hfToken = settings.getHfToken();
    const taskId = essential.startBatchDownload(source, hfToken);
    trackDownload(taskId);
    res.json({ taskId });
  } catch (err) { sendError(res, err, 500, 'Essential batch failed to start'); }
});

router.get(ESSENTIAL_PATHS.status, (_req: Request, res: Response) => {
  try { res.json(essential.getInstallStatus()); }
  catch (err) { sendError(res, err, 500, 'Essential status failed'); }
});

router.get(ESSENTIAL_PATHS.progress, (req: Request, res: Response) => {
  const id = req.params.id as string;
  const p = getTaskProgress(id);
  if (!p) {
    res.status(404).json({
      error: `Progress not found for id ${id}`,
      overallProgress: 0, status: 'unknown', completed: false,
      totalBytes: 0, downloadedBytes: 0, speed: 0,
    });
    return;
  }
  res.json({
    overallProgress: p.overallProgress || 0,
    currentModelIndex: p.currentModelIndex || 0,
    currentModelProgress: p.currentModelProgress || 0,
    currentModel: p.currentModel ? { ...p.currentModel } : null,
    completed: p.completed || false,
    error: p.error || null,
    totalBytes: p.totalBytes || 0,
    downloadedBytes: p.downloadedBytes || 0,
    speed: p.speed || 0,
    status: p.status || 'downloading',
  });
});

router.post(ESSENTIAL_PATHS.cancel, (req: Request, res: Response) => {
  const { taskId } = (req.body || {}) as { taskId?: string };
  if (!taskId) { res.status(400).json({ success: false, error: 'Missing task ID' }); return; }
  const ok = essential.cancelBatch(taskId);
  stopTracking(taskId);
  if (!ok) { res.status(404).json({ success: false, error: `Task not found: ${taskId}` }); return; }
  res.json({ success: true, message: 'Essential models download has been canceled' });
});

export default router;
