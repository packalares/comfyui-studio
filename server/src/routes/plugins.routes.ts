// Plugin routes. Endpoint list preserved 1:1 from the launcher catch-all.
// All paths dual-mount canonical + `/launcher/...` alias so the frontend's
// existing URLs keep working.
//
// Rate-limited writes (install, uninstall, disable, enable, custom install,
// switch-version) share a single middleware. Cache read + progress poll are
// unrestricted because they are read-only and polled frequently.

import { Router, type RequestHandler } from 'express';
import * as plugins from '../services/plugins/plugins.service.js';
import { sendError } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// 10 writes/min/IP keeps the pip install + git clone cadence sane.
const writeLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// ---- Handlers ----

const handleGetAll: RequestHandler = async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    if (forceRefresh) plugins.cache.refreshInstalledPlugins();
    res.json(plugins.cache.getAllPlugins(forceRefresh));
  } catch (err) { sendError(res, err, 500, 'Failed to get plugin list'); }
};

const handleInstall: RequestHandler = async (req, res) => {
  const { pluginId, githubProxy } = (req.body || {}) as { pluginId?: string; githubProxy?: string };
  if (!pluginId) { res.status(400).json({ success: false, message: 'pluginId required' }); return; }
  try {
    const list = plugins.cache.getAllPlugins(false);
    const info = list.find((p) => p.id === pluginId);
    if (!info) { res.status(404).json({ success: false, message: `Plugin not found: ${pluginId}` }); return; }
    const taskId = await plugins.install.installPlugin(pluginId, info, githubProxy);
    res.json({ success: true, message: 'Installation started', taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : 'Install failed' });
  }
};

const handleUninstall: RequestHandler = async (req, res) => {
  const { pluginId } = (req.body || {}) as { pluginId?: string };
  if (!pluginId) { res.status(400).json({ success: false, message: 'pluginId required' }); return; }
  try {
    const taskId = await plugins.uninstall.uninstallPlugin(pluginId);
    res.json({ success: true, message: 'Uninstall started', taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : 'Uninstall failed' });
  }
};

const handleDisable: RequestHandler = async (req, res) => {
  const { pluginId } = (req.body || {}) as { pluginId?: string };
  if (!pluginId) { res.status(400).json({ success: false, message: 'pluginId required' }); return; }
  try {
    const taskId = await plugins.uninstall.disablePlugin(pluginId);
    res.json({ success: true, message: 'Disable started', taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : 'Disable failed' });
  }
};

const handleEnable: RequestHandler = async (req, res) => {
  const { pluginId } = (req.body || {}) as { pluginId?: string };
  if (!pluginId) { res.status(400).json({ success: false, message: 'pluginId required' }); return; }
  try {
    const taskId = await plugins.uninstall.enablePlugin(pluginId);
    res.json({ success: true, message: 'Enable started', taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : 'Enable failed' });
  }
};

const handleProgress: RequestHandler = async (req, res) => {
  const taskId = String(req.params.taskId ?? '');
  const p = plugins.progress.getTaskProgress(taskId);
  if (!p) { res.status(404).json({ success: false, message: 'Task not found' }); return; }
  res.json(p);
};

const handleRefresh: RequestHandler = async (_req, res) => {
  try {
    const list = plugins.cache.refreshInstalledPlugins();
    res.json({ success: true, message: 'Plugin list refreshed', plugins: list });
  } catch (err) { sendError(res, err, 500, 'Refresh failed'); }
};

const handleCustomInstall: RequestHandler = async (req, res) => {
  const { githubUrl, branch } = (req.body || {}) as { githubUrl?: string; branch?: string };
  if (!githubUrl) { res.status(400).json({ success: false, message: 'githubUrl is required' }); return; }
  try {
    const { taskId, pluginId } = await plugins.install.installCustomPlugin(githubUrl, branch || 'main', undefined);
    res.json({ success: true, message: 'Custom install started', taskId, pluginId });
  } catch (err) {
    res.status(400).json({ success: false, message: err instanceof Error ? err.message : 'Install failed' });
  }
};

const handleSwitchVersion: RequestHandler = async (req, res) => {
  const { pluginId, targetVersion, githubProxy } = (req.body || {}) as {
    pluginId?: string; targetVersion?: { id?: string; version?: string };
    githubProxy?: string;
  };
  if (!pluginId || !targetVersion) {
    res.status(400).json({ success: false, message: 'pluginId and targetVersion are required' });
    return;
  }
  try {
    const list = plugins.cache.getAllPlugins(false);
    const pluginInfo = list.find((p) => p.id === pluginId);
    if (!pluginInfo) { res.status(404).json({ success: false, message: `Plugin not found: ${pluginId}` }); return; }
    const repositoryUrl = pluginInfo.repository || pluginInfo.github || '';
    if (!repositoryUrl) { res.status(400).json({ success: false, message: 'Plugin has no repository URL' }); return; }
    const proxy = (typeof githubProxy === 'string' && githubProxy) ? githubProxy : '';
    const taskId = plugins.switchVersion.switchPluginVersion(pluginId, repositoryUrl, targetVersion, proxy);
    res.json({ success: true, message: `Switching to ${targetVersion.version ?? 'target'}`, taskId });
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : 'Switch failed' });
  }
};

const handleUpdateCache: RequestHandler = async (_req, res) => {
  try {
    plugins.cache.clearCache();
    const list = plugins.cache.getAllPlugins(true);
    res.json({ success: true, message: 'Cache updated', nodesCount: list.length });
  } catch (err) { sendError(res, err, 500, 'Update failed'); }
};

const handleHistory: RequestHandler = async (req, res) => {
  const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
  try { res.json({ success: true, history: plugins.history.getHistory(limit) }); }
  catch (err) { sendError(res, err, 500, 'Failed to get history'); }
};

const handleLogs: RequestHandler = async (req, res) => {
  const taskId = String(req.params.taskId ?? '');
  const logs = plugins.history.getLogs(taskId);
  if (!logs) { res.status(404).json({ success: false, message: 'Task not found' }); return; }
  res.json({ success: true, logs });
};

const handleHistoryClear: RequestHandler = async (_req, res) => {
  try { plugins.history.clearHistory(); res.json({ success: true, message: 'History cleared' }); }
  catch (err) { sendError(res, err, 500, 'Clear failed'); }
};

const handleHistoryDelete: RequestHandler = async (req, res) => {
  const { id } = (req.body || {}) as { id?: string };
  if (!id) { res.status(400).json({ success: false, message: 'History id required' }); return; }
  const removed = plugins.history.deleteHistoryItem(id);
  if (!removed) { res.status(404).json({ success: false, message: 'History item not found' }); return; }
  res.json({ success: true, message: `History item deleted: ${removed.pluginId}` });
};

// ---- Mount canonical + legacy aliases ----

router.get(['/plugins', '/launcher/plugins'], handleGetAll);
router.post(['/plugins/install', '/launcher/plugins/install'], writeLimiter, handleInstall);
router.post(['/plugins/uninstall', '/launcher/plugins/uninstall'], writeLimiter, handleUninstall);
router.get(['/plugins/progress/:taskId', '/launcher/plugins/progress/:taskId'], handleProgress);
router.post(['/plugins/disable', '/launcher/plugins/disable'], writeLimiter, handleDisable);
router.post(['/plugins/enable', '/launcher/plugins/enable'], writeLimiter, handleEnable);
router.get(['/plugins/refresh', '/launcher/plugins/refresh'], handleRefresh);
router.post(['/plugins/install-custom', '/launcher/plugins/install-custom'], writeLimiter, handleCustomInstall);
router.post(['/plugins/switch-version', '/launcher/plugins/switch-version'], writeLimiter, handleSwitchVersion);
router.post(['/plugins/update-cache', '/launcher/plugins/update-cache'], handleUpdateCache);
router.get(['/plugins/history', '/launcher/plugins/history'], handleHistory);
router.get(['/plugins/logs/:taskId', '/launcher/plugins/logs/:taskId'], handleLogs);
router.post(['/plugins/history/clear', '/launcher/plugins/history/clear'], handleHistoryClear);
router.post(['/plugins/history/delete', '/launcher/plugins/history/delete'], handleHistoryDelete);

export default router;
