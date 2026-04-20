// Python / pip routes.
//   GET  /python/pip-source
//   POST /python/pip-source
//   GET  /python/packages
//   POST /python/packages/install
//   POST /python/packages/uninstall
//   GET  /python/plugins/dependencies
//   POST /python/plugins/fix-dependencies
//
// Dual-mounted with legacy `/launcher/python/...` aliases. All rate-limited
// write endpoints use the shared `rateLimit` middleware.

import { Router, type RequestHandler } from 'express';
import * as pipSource from '../services/python/pipSource.service.js';
import * as packages from '../services/python/packages.service.js';
import * as deps from '../services/python/dependencies.service.js';
import { sendError } from '../middleware/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Package install/uninstall invoke pip — 10/min is plenty for interactive use.
const pkgLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// ---- Handlers ----

const handleGetPipSource: RequestHandler = async (_req, res) => {
  try { res.send(pipSource.getPipSource()); }
  catch (err) { sendError(res, err, 500, 'Failed to read pip source'); }
};

const handleSetPipSource: RequestHandler = async (req, res) => {
  const { source } = (req.body || {}) as { source?: string };
  if (!source) { res.status(400).json({ error: 'Source URL cannot be empty' }); return; }
  try {
    pipSource.setPipSource(source);
    res.json({ success: true, message: 'pip source updated' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
};

const handleListPackages: RequestHandler = async (_req, res) => {
  try {
    const list = await packages.listInstalledPackages();
    res.json(list);
  } catch (err) { sendError(res, err, 500, 'Failed to list packages'); }
};

const handleInstallPackage: RequestHandler = async (req, res) => {
  const { package: spec } = (req.body || {}) as { package?: string };
  if (!spec) { res.status(400).json({ error: 'Package name cannot be empty' }); return; }
  try {
    const r = await packages.installPackage(spec);
    res.json({ success: true, message: 'Install succeeded', output: r.output });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Install failed: ${msg}` });
  }
};

const handleUninstallPackage: RequestHandler = async (req, res) => {
  const { package: name } = (req.body || {}) as { package?: string };
  if (!name) { res.status(400).json({ error: 'Package name cannot be empty' }); return; }
  try {
    const r = await packages.uninstallPackage(name);
    res.json({ success: true, message: 'Uninstall succeeded', output: r.output });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Uninstall failed: ${msg}` });
  }
};

const handlePluginDeps: RequestHandler = async (_req, res) => {
  try {
    const r = await deps.analyzePluginDependencies();
    res.json(r);
  } catch (err) { sendError(res, err, 500, 'Failed to analyze plugin dependencies'); }
};

const handleFixDeps: RequestHandler = async (req, res) => {
  const { plugin } = (req.body || {}) as { plugin?: string };
  if (!plugin) { res.status(400).json({ error: 'Plugin name cannot be empty' }); return; }
  try {
    const r = await deps.fixPluginDependencies(plugin);
    res.json({ success: true, message: 'Dependencies fixed', output: r.output });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Dependency fix failed: ${msg}` });
  }
};

// ---- Mount canonical + legacy aliases ----

router.get(['/python/pip-source', '/launcher/python/pip-source'], handleGetPipSource);
router.post(['/python/pip-source', '/launcher/python/pip-source'], handleSetPipSource);
router.get(['/python/packages', '/launcher/python/packages'], handleListPackages);
router.post(['/python/packages/install', '/launcher/python/packages/install'], pkgLimiter, handleInstallPackage);
router.post(['/python/packages/uninstall', '/launcher/python/packages/uninstall'], pkgLimiter, handleUninstallPackage);
router.get(['/python/plugins/dependencies', '/launcher/python/plugins/dependencies'], handlePluginDeps);
router.post(['/python/plugins/fix-dependencies', '/launcher/python/plugins/fix-dependencies'], pkgLimiter, handleFixDeps);

export default router;
