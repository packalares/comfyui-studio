// POST /api/system/:key — system network-config setters.
// Each key maps to one configurator setter; body is `{ value }`.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as configurator from '../services/settings/network.js';
import type { ConfigureResult } from '../services/settings/network.js';

type SetterResult = ConfigureResult;
type SetterFn = (rawValue: unknown) => SetterResult;

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function parseHostList(v: unknown): { ok: true; hosts: string[] } | { ok: false; message: string } {
  if (Array.isArray(v)) return { ok: true, hosts: v.filter((h): h is string => typeof h === 'string') };
  if (typeof v === 'string') return { ok: true, hosts: v.split(',').map(h => h.trim()).filter(Boolean) };
  return { ok: false, message: 'value must be string[] or comma-separated string' };
}

const SETTERS: Record<string, SetterFn> = {
  'pip-source': (v) => { const s = asNonEmptyString(v); return s ? configurator.setPipSourceConfig(s) : { success: false, message: 'value must be a non-empty string', data: null }; },
  'huggingface-endpoint': (v) => { const s = asNonEmptyString(v); return s ? configurator.setHuggingFaceEndpoint(s) : { success: false, message: 'value must be a non-empty string', data: null }; },
  'github-proxy': (v) => { const s = asNonEmptyString(v); return s ? configurator.setGithubProxyConfig(s) : { success: false, message: 'value must be a non-empty string', data: null }; },
  'plugin-trusted-hosts': (v) => { const p = parseHostList(v); return p.ok ? configurator.setPluginTrustedHostsConfig(p.hosts) : { success: false, message: p.message, data: null }; },
  'model-trusted-hosts': (v) => { const p = parseHostList(v); return p.ok ? configurator.setModelTrustedHostsConfig(p.hosts) : { success: false, message: p.message, data: null }; },
  'pip-allow-private-ip': (v) => { if (typeof v !== 'boolean') return { success: false, message: 'value must be boolean', data: null }; return configurator.setAllowPrivateIpMirrorsConfig(v); },
};

const configLimiter = rateLimit('network:config');

const setSystemConfigRoute = defineRoute({
  method: 'POST',
  path: '/system/:key',
  params: z.object({ key: z.string().min(1) }),
  body: z.object({ value: z.unknown() }),
  response: z.object({
    success: z.boolean(),
    message: z.string(),
    data: z.unknown().nullable(),
  }),
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['system'],
  summary: 'Set a network/system config value by key',
}, ({ params, body, ok }) => {
  // Own-property lookup only — otherwise `params.key` could resolve to an
  // inherited method (e.g. `toString`) and get invoked as a setter.
  const setter = Object.hasOwn(SETTERS, params.key) ? SETTERS[params.key] : undefined;
  if (!setter) throw new NotFoundError(`unknown system config key: ${params.key}`);
  const result = setter(body.value);
  if (!result.success) throw new ValidationError(result.message);
  return ok({ success: true, message: result.message, data: result.data ?? null });
});

const router = Router();
router.use('/system/:key', configLimiter);
setSystemConfigRoute.register(router);

configurator.loadPersisted();

export default router;
