// Local ComfyUI lifecycle routes: status / start / stop / restart / logs /
// reset / launch-options.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { getProcessService } from '../services/comfyui/singleton.js';
import {
  getLaunchCommandView,
  resetToDefault,
  updateLaunchOptions,
  type LaunchOptionsConfig,
} from '../services/comfyui/launchOptions.service.js';
import { sendError } from '../middleware/errors.js';

const router = Router();

// ---- Lifecycle ----

const handleStart: RequestHandler = async (_req, res) => {
  try {
    const result = await getProcessService().startComfyUI();
    if (!result.success) res.status(500);
    res.json(result);
  } catch (err) { sendError(res, err, 500, 'Start failed'); }
};

const handleStop: RequestHandler = async (_req, res) => {
  try {
    const result = await getProcessService().stopComfyUI();
    if (!result.success) res.status(500);
    res.json(result);
  } catch (err) { sendError(res, err, 500, 'Stop failed'); }
};

const handleRestart: RequestHandler = async (_req, res) => {
  try {
    const result = await getProcessService().restartComfyUI();
    if (!result.success) res.status(500);
    res.json(result);
  } catch (err) { sendError(res, err, 500, 'Restart failed'); }
};

// ---- Logs ----

const handleLogs: RequestHandler = async (_req, res) => {
  try {
    const logs = getProcessService().getLogStore().getRecentLogs();
    res.json({ logs });
  } catch (err) { sendError(res, err, 500, 'Log read failed'); }
};

// ---- Reset ----

interface ResetBody { mode?: 'normal' | 'hard' }

const handleReset: RequestHandler = async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as ResetBody;
    const mode = body.mode === 'hard' ? 'hard' : 'normal';
    const result = await getProcessService().resetComfyUI(mode);
    if (!result.success) res.status(500);
    res.json(result);
  } catch (err) { sendError(res, err, 500, 'Reset failed'); }
};

const handleResetLogs: RequestHandler = async (_req, res) => {
  try {
    const logs = getProcessService().getLogStore().getResetLogs();
    const message = logs.length === 0
      ? 'No reset logs found'
      : `Retrieved ${logs.length} reset log entries`;
    res.json({ logs, success: true, message });
  } catch (err) { sendError(res, err, 500, 'Reset log read failed'); }
};

// ---- Launch options ----

const handleGetLaunchOptions: RequestHandler = async (_req, res) => {
  try {
    res.json({ code: 200, message: 'ok', data: getLaunchCommandView() });
  } catch (err) { sendError(res, err, 500, 'Failed to get launch options'); }
};

const handlePutLaunchOptions: RequestHandler = async (req, res) => {
  try {
    const payload = (req.body || {}) as Partial<LaunchOptionsConfig>;
    updateLaunchOptions(payload);
    res.json({ code: 200, message: 'ok', data: getLaunchCommandView() });
  } catch (err) { sendError(res, err, 500, 'Failed to update launch options'); }
};

const handleResetLaunchOptions: RequestHandler = async (_req, res) => {
  try {
    resetToDefault();
    res.json({ code: 200, message: 'ok', data: getLaunchCommandView() });
  } catch (err) { sendError(res, err, 500, 'Failed to reset launch options'); }
};

router.post('/start', handleStart);
router.post('/stop', handleStop);
router.post('/restart', handleRestart);
router.get('/comfyui/logs', handleLogs);
router.post('/comfyui/reset', handleReset);
router.get('/comfyui/reset-logs', handleResetLogs);
router.get('/comfyui/launch-options', handleGetLaunchOptions);
router.put('/comfyui/launch-options', handlePutLaunchOptions);
router.post('/comfyui/launch-options/reset', handleResetLaunchOptions);

export default router;
