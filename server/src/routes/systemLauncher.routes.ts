// System-controller HTTP routes. Exposes config-write endpoints under
// `/api/system/*` plus a single `GET /system/network-config` aggregator the
// settings UI uses to render the Network card.
//
// Rate limiting:
//   - POST /pip-source           : 10 / minute — config writes are cheap.
//   - POST /huggingface-endpoint : 10 / minute.
//   - POST /github-proxy         : 10 / minute.
//   - POST /plugin-trusted-hosts : 10 / minute.
//   - POST /model-trusted-hosts  : 10 / minute.
//   - POST /pip-allow-private-ip : 10 / minute.
//
// `GET /network-config` is uncapped because it is polled by the settings UI.

import { Router, type Request, type RequestHandler } from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import * as system from '../services/systemLauncher/system.service.js';
import * as configurator from '../services/systemLauncher/configurator.service.js';
import * as networkChecker from '../services/systemLauncher/networkChecker/service.js';

const router = Router();

const configLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// ---- GET handlers ----

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

// ---- POST handlers ----

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

function readHostList(req: Request): { ok: true; hosts: string[] } | { ok: false; message: string } {
  const body = req.body as { hosts?: unknown };
  if (Array.isArray(body?.hosts)) {
    return { ok: true, hosts: body.hosts.filter((h): h is string => typeof h === 'string') };
  }
  if (typeof body?.hosts === 'string') {
    return { ok: true, hosts: body.hosts.split(',').map(h => h.trim()).filter(Boolean) };
  }
  return { ok: false, message: 'hosts must be string[] or comma-separated string' };
}

const handlePluginTrustedHosts: RequestHandler = (req, res) => {
  const parsed = readHostList(req);
  if (!parsed.ok) { res.status(400).json({ code: 400, message: parsed.message, data: null }); return; }
  const result = configurator.setPluginTrustedHosts(parsed.hosts);
  res.status(result.success ? 200 : 400).json({
    code: result.success ? 200 : 400,
    message: result.message,
    data: result.data ?? null,
  });
};

const handleModelTrustedHosts: RequestHandler = (req, res) => {
  const parsed = readHostList(req);
  if (!parsed.ok) { res.status(400).json({ code: 400, message: parsed.message, data: null }); return; }
  const result = configurator.setModelTrustedHosts(parsed.hosts);
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

// ---- Routes ----

router.get('/system/network-config', handleNetworkConfig);

router.post('/system/pip-source', configLimiter, handlePipSource);
router.post('/system/huggingface-endpoint', configLimiter, handleHfEndpoint);
router.post('/system/github-proxy', configLimiter, handleGithubProxy);
router.post('/system/plugin-trusted-hosts', configLimiter, handlePluginTrustedHosts);
router.post('/system/model-trusted-hosts', configLimiter, handleModelTrustedHosts);
router.post('/system/pip-allow-private-ip', configLimiter, handleAllowPrivateIp);

// Load persisted values once at import time so `liveSettings` reflects the
// most recent configurator state before any consumer reads it.
configurator.loadPersisted();

export default router;
