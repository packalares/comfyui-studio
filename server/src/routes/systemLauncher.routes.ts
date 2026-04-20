// System-controller HTTP routes. Exposes 9 endpoints under `/api/system/*`.
// Each path is dual-mounted (`/system/...` + `/launcher/system/...`) so
// pre-cutover frontend calls keep working alongside the canonical prefix.
//
// Rate limiting:
//   - POST /network-status   : 3 / minute — curl burst guard.
//   - POST /pip-source       : 10 / minute — config writes are cheap.
//   - POST /huggingface-endpoint : 10 / minute.
//   - POST /github-proxy     : 10 / minute.
//
// Reads (`GET /network-config`, `GET /network-status`, log fetch) are
// uncapped because they are polled by the settings UI.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';
import * as system from '../services/systemLauncher/system.service.js';
import * as configurator from '../services/systemLauncher/configurator.service.js';
import * as networkChecker from '../services/systemLauncher/networkChecker/service.js';
import { isValidId } from '../services/systemLauncher/networkChecker/logs.js';

const router = Router();

const checkLimiter = rateLimit({ windowMs: 60_000, max: 3 });
const configLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// ---- GET handlers ----

const handleOpenPath: RequestHandler = async (req, res) => {
  const pathParam = typeof req.query.path === 'string' ? req.query.path : '';
  try {
    const r = await system.openPath(pathParam);
    res.status(r.code).json(r);
  } catch (err) { sendError(res, err, 500, 'open-path failed'); }
};

const handleFilesBasePath: RequestHandler = (_req, res) => {
  res.json(system.getFilesBasePath());
};

const handleNetworkStatusGet: RequestHandler = (_req, res) => {
  const last = networkChecker.getLastResult();
  res.json({ code: 200, message: 'ok', data: last });
};

const handleNetworkConfig: RequestHandler = (_req, res) => {
  const last = networkChecker.getLastResult();
  // First-boot UX: if we have never probed reachability, kick a check off
  // in the background so subsequent /network-config calls surface real data.
  // `triggerCheck` is async + independent; this caller keeps returning now.
  if (!last) networkChecker.triggerCheck();
  const data = system.getNetworkConfig(
    last
      ? Object.fromEntries(
          Object.entries(last).map(([k, v]) => [k, { accessible: v.accessible, latencyMs: v.latencyMs }]),
        )
      : null,
  );
  res.json({ code: 200, message: 'ok', data });
};

const handleNetworkCheckLog: RequestHandler = (req, res) => {
  const id = String(req.params.id ?? '');
  if (!isValidId(id)) { res.status(400).json({ code: 400, message: 'invalid id', data: null }); return; }
  const log = networkChecker.getLog(id);
  if (!log) { res.status(404).json({ code: 404, message: 'log not found', data: null }); return; }
  res.json({ code: 200, message: 'ok', data: { log, currentNetworkStatus: networkChecker.getLastResult() } });
};

// ---- POST handlers ----

const handleNetworkStatusPost: RequestHandler = (_req, res) => {
  const result = networkChecker.triggerCheck();
  res.json({ code: 200, message: 'network check started', data: result });
};

// Accept several field names per endpoint so legacy launcher callers AND
// the studio frontend (which uses shorter keys) both work without changes.
function readUrl(req: Request, keys: string[]): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body) return null;
  for (const k of keys) {
    const raw = body[k];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

const handlePipSource: RequestHandler = (req, res) => {
  const url = readUrl(req, ['pipUrl', 'source', 'url']);
  if (!url) { res.status(400).json({ code: 400, message: 'pipUrl required', data: null }); return; }
  const result = configurator.setPipSource(url);
  res.status(result.success ? 200 : 400).json({
    code: result.success ? 200 : 400,
    message: result.message,
    data: result.data ?? null,
  });
};

const handleHfEndpoint: RequestHandler = (req, res) => {
  const url = readUrl(req, ['hfEndpoint', 'endpoint', 'url']);
  if (!url) { res.status(400).json({ code: 400, message: 'hfEndpoint required', data: null }); return; }
  const result = configurator.setHuggingFaceEndpoint(url);
  res.status(result.success ? 200 : 400).json({
    code: result.success ? 200 : 400,
    message: result.message,
    data: result.data ?? null,
  });
};

const handleGithubProxy: RequestHandler = (req, res) => {
  const url = readUrl(req, ['githubProxy', 'proxy', 'url']);
  if (!url) { res.status(400).json({ code: 400, message: 'githubProxy required', data: null }); return; }
  const result = configurator.setGithubProxy(url);
  res.status(result.success ? 200 : 400).json({
    code: result.success ? 200 : 400,
    message: result.message,
    data: result.data ?? null,
  });
};

const handlePluginTrustedHosts: RequestHandler = (req, res) => {
  const body = req.body as { hosts?: unknown };
  let hosts: string[] = [];
  if (Array.isArray(body?.hosts)) {
    hosts = body.hosts.filter((h): h is string => typeof h === 'string');
  } else if (typeof body?.hosts === 'string') {
    hosts = body.hosts.split(',').map(h => h.trim()).filter(Boolean);
  } else {
    res.status(400).json({ code: 400, message: 'hosts must be string[] or comma-separated string', data: null });
    return;
  }
  const result = configurator.setPluginTrustedHosts(hosts);
  res.status(result.success ? 200 : 400).json({
    code: result.success ? 200 : 400,
    message: result.message,
    data: result.data ?? null,
  });
};

const handleAllowPrivateIp: RequestHandler = (req, res) => {
  const body = req.body as { allow?: unknown };
  if (typeof body?.allow !== 'boolean') {
    res.status(400).json({ code: 400, message: 'allow must be boolean', data: null });
    return;
  }
  const result = configurator.setAllowPrivateIpMirrors(body.allow);
  res.status(result.success ? 200 : 400).json({
    code: result.success ? 200 : 400,
    message: result.message,
    data: result.data ?? null,
  });
};

// ---- Dual-mounted routes ----

router.get(['/system/open-path', '/launcher/system/open-path'], handleOpenPath);
router.get(['/system/files-base-path', '/launcher/system/files-base-path'], handleFilesBasePath);
router.get(['/system/network-status', '/launcher/system/network-status'], handleNetworkStatusGet);
router.get(['/system/network-config', '/launcher/system/network-config'], handleNetworkConfig);
router.get(['/system/network-check-log/:id', '/launcher/system/network-check-log/:id'], handleNetworkCheckLog);

router.post(['/system/network-status', '/launcher/system/network-status'], checkLimiter, handleNetworkStatusPost);
router.post(['/system/pip-source', '/launcher/system/pip-source'], configLimiter, handlePipSource);
router.post(['/system/huggingface-endpoint', '/launcher/system/huggingface-endpoint'], configLimiter, handleHfEndpoint);
router.post(['/system/github-proxy', '/launcher/system/github-proxy'], configLimiter, handleGithubProxy);
router.post(['/system/plugin-trusted-hosts', '/launcher/system/plugin-trusted-hosts'], configLimiter, handlePluginTrustedHosts);
router.post(['/system/pip-allow-private-ip', '/launcher/system/pip-allow-private-ip'], configLimiter, handleAllowPrivateIp);

// Load persisted values once at import time so `liveSettings` reflects the
// most recent configurator state before any consumer reads it.
configurator.loadPersisted();

export default router;
