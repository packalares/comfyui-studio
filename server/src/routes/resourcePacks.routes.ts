// Resource-pack routes.
//   GET  /resource-packs
//   GET  /resource-packs/:id
//   POST /resource-packs/install
//   GET  /resource-packs/progress/:taskId
//   POST /resource-packs/cancel/:taskId
//
// Dual-mounted with `/launcher/resource-packs/...` aliases so the existing
// frontend keeps working. Install is fire-and-forget: the response returns
// immediately with a taskId.

import { Router, type RequestHandler } from 'express';
import { InstallStatus, type ResourcePack } from '../contracts/resourcePacks.contract.js';
import { findPack, loadResourcePacks } from '../services/resourcePacks/packStore.js';
import * as progressManager from '../services/resourcePacks/progressManager.js';
import {
  cancelInstallation, startResourcePackInstallation,
} from '../services/resourcePacks/resourcePacks.service.js';
import { sendError } from '../middleware/errors.js';

const router = Router();

const handleList: RequestHandler = async (_req, res) => {
  try { res.json(loadResourcePacks()); }
  catch (err) { sendError(res, err, 500, 'Failed to list resource packs'); }
};

const handleDetail: RequestHandler = async (req, res) => {
  const id = String(req.params.id ?? '');
  const pack = findPack(id);
  if (!pack) { res.status(404).json({ error: `Resource pack not found: ${id}` }); return; }
  res.json(pack);
};

interface InstallBody {
  packId?: string;
  selectedResources?: string[];
  source?: string;
}

const handleInstall: RequestHandler = async (req, res) => {
  const { packId, selectedResources, source = 'hf' } = (req.body || {}) as InstallBody;
  if (!packId) { res.status(400).json({ error: 'packId is required' }); return; }
  const pack = findPack(packId);
  if (!pack) { res.status(404).json({ error: `Resource pack not found: ${packId}` }); return; }
  const taskId = packId;
  if (progressManager.hasActiveTask(taskId)) {
    res.json({ taskId, existing: true });
    return;
  }
  progressManager.createProgress(pack as ResourcePack, taskId);
  void startResourcePackInstallation(pack as ResourcePack, taskId, source, selectedResources)
    .catch((err) => {
      progressManager.updateTaskStatus(
        taskId, InstallStatus.ERROR,
        err instanceof Error ? err.message : String(err),
      );
    });
  res.json({ taskId, existing: false });
};

const handleProgress: RequestHandler = async (req, res) => {
  const taskId = String(req.params.taskId ?? '');
  const p = progressManager.getProgress(taskId);
  if (!p) { res.status(404).json({ error: `Progress not found for ${taskId}` }); return; }
  res.json(p);
};

const handleCancel: RequestHandler = async (req, res) => {
  const taskId = String(req.params.taskId ?? '');
  const p = progressManager.getProgress(taskId);
  if (!p) { res.status(404).json({ error: `Progress not found for ${taskId}` }); return; }
  if (p.status === InstallStatus.COMPLETED
    || p.status === InstallStatus.ERROR
    || p.status === InstallStatus.CANCELED) {
    res.status(400).json({ error: 'Task already finished' });
    return;
  }
  try {
    const ok = cancelInstallation(taskId);
    if (!ok) { res.status(500).json({ error: 'Cancel failed' }); return; }
    res.json({ success: true, message: 'Install canceled', taskId });
  } catch (err) { sendError(res, err, 500, 'Cancel failed'); }
};

// ---- Mount canonical + legacy aliases ----

router.get(['/resource-packs', '/launcher/resource-packs'], handleList);
router.get(['/resource-packs/:id', '/launcher/resource-packs/:id'], handleDetail);
router.post(['/resource-packs/install', '/launcher/resource-packs/install'], handleInstall);
router.get(
  ['/resource-packs/progress/:taskId', '/launcher/resource-packs/progress/:taskId'],
  handleProgress,
);
router.post(
  ['/resource-packs/cancel/:taskId', '/launcher/resource-packs/cancel/:taskId'],
  handleCancel,
);

export default router;
