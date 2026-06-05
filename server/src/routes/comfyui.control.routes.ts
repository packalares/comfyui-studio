// ComfyUI control routes — interrupt + cancel queued prompts.
//
// Proxies ComfyUI's two mutating endpoints:
//   POST /interrupt    — stops the currently-executing prompt.
//   POST /queue        — `{ delete: [promptId] }` removes a pending queue entry.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { UpstreamUnavailableError } from '../lib/errors.js';
import { getComfyUIUrl } from '../services/comfyui/api.js';
import { logger } from '../lib/logger.js';

async function proxyMutation(
  comfyPath: string,
  body: Record<string, unknown> | null,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const url = `${getComfyUIUrl()}${comfyPath}`;
  try {
    const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (body !== null) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (res.ok) return { ok: true, status: res.status };
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    return { ok: false, status: res.status, detail };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

const OkResponseSchema = z.object({ ok: z.literal(true) });

const interruptRoute = defineRoute({
  method: 'POST',
  path: '/comfyui/interrupt',
  response: OkResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['comfyui'],
  summary: 'Interrupt the currently-executing ComfyUI prompt',
}, async ({ ok }) => {
  const r = await proxyMutation('/interrupt', null);
  if (r.ok) return ok({ ok: true as const });
  logger.warn('comfyui interrupt: upstream failed', { status: r.status, detail: r.detail });
  throw new UpstreamUnavailableError(`ComfyUI interrupt failed (${r.status})`, { detail: r.detail });
});

const queueDeleteRoute = defineRoute({
  method: 'POST',
  path: '/comfyui/queue/delete',
  body: z.object({ promptId: z.string().min(1) }),
  response: OkResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['comfyui'],
  summary: 'Remove a pending prompt from the ComfyUI queue',
}, async ({ body, ok }) => {
  const r = await proxyMutation('/queue', { delete: [body.promptId] });
  if (r.ok) return ok({ ok: true as const });
  logger.warn('comfyui queue delete: upstream failed', { status: r.status, detail: r.detail, promptId: body.promptId });
  throw new UpstreamUnavailableError(`ComfyUI queue delete failed (${r.status})`, { detail: r.detail });
});

const router = Router();
interruptRoute.register(router);
queueDeleteRoute.register(router);

export default router;
