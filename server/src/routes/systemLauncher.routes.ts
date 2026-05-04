// System-controller HTTP routes. A single dynamic POST handler dispatches to
// the matching configurator setter via the SETTERS map below; every key
// accepts the same body shape `{ value }` so the UI ships one helper.
//
// The legacy GET `/system/network-config` aggregator has been folded into
// `GET /system` — the dashboard reads `network` off that response now.
//
// Rate limiting: each config write is capped at 10/minute (cheap operations,
// but the per-route cap blunts accidental loops in the UI).

import { Router, type RequestHandler } from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import * as configurator from '../services/systemLauncher/configurator.service.js';
import type { ConfigureResult } from '../services/systemLauncher/configurator.service.js';

const router = Router();

const configLimiter = rateLimit({ windowMs: 60_000, max: 10 });

type SetterResult = ConfigureResult;
type SetterFn = (rawValue: unknown) => SetterResult;

function bad(message: string): SetterResult {
  return { success: false, message, data: null };
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Accept either `string[]` or comma-separated string so legacy callers that
// passed `"a,b,c"` keep working alongside the modern array form.
function parseHostList(v: unknown): { ok: true; hosts: string[] } | { ok: false; message: string } {
  if (Array.isArray(v)) {
    return { ok: true, hosts: v.filter((h): h is string => typeof h === 'string') };
  }
  if (typeof v === 'string') {
    return { ok: true, hosts: v.split(',').map(h => h.trim()).filter(Boolean) };
  }
  return { ok: false, message: 'value must be string[] or comma-separated string' };
}

const SETTERS: Record<string, SetterFn> = {
  'pip-source': (v) => {
    const s = asNonEmptyString(v);
    return s ? configurator.setPipSource(s) : bad('value must be a non-empty string');
  },
  'huggingface-endpoint': (v) => {
    const s = asNonEmptyString(v);
    return s ? configurator.setHuggingFaceEndpoint(s) : bad('value must be a non-empty string');
  },
  'github-proxy': (v) => {
    const s = asNonEmptyString(v);
    return s ? configurator.setGithubProxy(s) : bad('value must be a non-empty string');
  },
  'plugin-trusted-hosts': (v) => {
    const parsed = parseHostList(v);
    return parsed.ok ? configurator.setPluginTrustedHosts(parsed.hosts) : bad(parsed.message);
  },
  'model-trusted-hosts': (v) => {
    const parsed = parseHostList(v);
    return parsed.ok ? configurator.setModelTrustedHosts(parsed.hosts) : bad(parsed.message);
  },
  'pip-allow-private-ip': (v) => {
    if (typeof v !== 'boolean') return bad('value must be boolean');
    return configurator.setAllowPrivateIpMirrors(v);
  },
};

const handleSetConfig: RequestHandler = (req, res) => {
  const rawKey = req.params.key;
  const key = typeof rawKey === 'string' ? rawKey : '';
  const setter = SETTERS[key];
  if (!setter) {
    res.status(404).json({ code: 404, message: 'unknown key', data: null });
    return;
  }
  const body = req.body as { value?: unknown } | undefined;
  const result = setter(body?.value);
  res.status(result.success ? 200 : 400).json({
    code: result.success ? 200 : 400,
    message: result.message,
    data: result.data ?? null,
  });
};

router.post('/system/:key', configLimiter, handleSetConfig);

// Load persisted values once at import time so `liveSettings` reflects the
// most recent configurator state before any consumer reads it.
configurator.loadPersisted();

export default router;
