// ComfyUI control routes — interrupt + cancel queued prompts.
//
// Thin proxies around the two upstream mutating endpoints ComfyUI exposes:
//   POST /interrupt            — stops the currently-executing prompt.
//   POST /queue                — body `{ delete: [promptId] }` removes a
//                                pending entry from the queue.
//
// Both are dual-mounted under `/api/launcher/...` to match the existing
// alias convention in routes/comfyui.routes.ts. Successful upstream 2xx
// surfaces as `{ ok: true }`; non-2xx (or network errors) fail with 502 so
// the UI can distinguish "the user's intent was valid, ComfyUI misbehaved"
// from a client-side 4xx.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { getComfyUIUrl } from '../services/comfyui.js';
import { logger } from '../lib/logger.js';

const router = Router();

async function proxyMutation(
  comfyPath: string,
  body: Record<string, unknown> | null,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const url = `${getComfyUIUrl()}${comfyPath}`;
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== null) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (res.ok) return { ok: true, status: res.status };
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    return { ok: false, status: res.status, detail };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

const handleInterrupt: RequestHandler = async (_req, res) => {
  const r = await proxyMutation('/interrupt', null);
  if (r.ok) {
    res.json({ ok: true });
    return;
  }
  logger.warn('comfyui interrupt: upstream failed', {
    status: r.status, detail: r.detail,
  });
  res.status(502).json({
    error: 'upstream_failed',
    upstreamStatus: r.status,
    detail: r.detail,
  });
};

const handleQueueDelete: RequestHandler = async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { promptId?: unknown };
  const promptId = body.promptId;
  if (typeof promptId !== 'string' || promptId.length === 0) {
    res.status(400).json({ error: 'promptId required (non-empty string)' });
    return;
  }
  const r = await proxyMutation('/queue', { delete: [promptId] });
  if (r.ok) {
    res.json({ ok: true });
    return;
  }
  logger.warn('comfyui queue delete: upstream failed', {
    status: r.status, detail: r.detail, promptId,
  });
  res.status(502).json({
    error: 'upstream_failed',
    upstreamStatus: r.status,
    detail: r.detail,
  });
};

router.post(
  ['/comfyui/interrupt', '/launcher/comfyui/interrupt'],
  handleInterrupt,
);
router.post(
  ['/comfyui/queue/delete', '/launcher/comfyui/queue/delete'],
  handleQueueDelete,
);

export default router;
