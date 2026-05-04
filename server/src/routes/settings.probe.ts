// Unified probe for the Settings page validate-before-save flow. Replaces
// the two duplicated handlers (Ollama and SearXNG) — the only differences
// were the appended sub-path and the success-payload key, both now selected
// via the `type` body field.
//
// Important: parse the user's URL FIRST, then build the probe URL on the
// parsed origin. If we appended the sub-path before validating, error
// messages from `new URL(...)` would leak the appended path back to the
// user (`Failed to parse URL from fdfsd/search?format=json...`), which they
// never typed.

import type { Request, Response } from 'express';

type ProbeType = 'ollama' | 'searxng';
const PROBE_TYPES: readonly ProbeType[] = ['ollama', 'searxng'];

const SUB_PATH: Record<ProbeType, string> = {
  ollama: '/api/tags',
  searxng: '/search?format=json&q=hello&pageno=1',
};

const PROBE_TIMEOUT_MS = 4000;

interface ProbeBody {
  type?: unknown;
  url?: unknown;
}

export async function runProbe(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as ProbeBody;
  const type = body.type;
  if (typeof type !== 'string' || !PROBE_TYPES.includes(type as ProbeType)) {
    res.status(400).json({ ok: false, error: 'unknown probe type' });
    return;
  }
  const rawUrl = body.url;
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    res.status(400).json({ ok: false, error: 'url is required' });
    return;
  }
  // Strip a trailing slash so we don't end up with `//api/tags`.
  const cleaned = rawUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    res.json({ ok: false, error: 'Invalid URL' });
    return;
  }

  const probeUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${SUB_PATH[type as ProbeType]}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = type === 'searxng'
      ? { Accept: 'application/json' }
      : {};
    const r = await fetch(probeUrl, { headers, signal: ctrl.signal });
    if (!r.ok) {
      res.json({ ok: false, error: `upstream ${r.status} ${r.statusText}` });
      return;
    }
    if (type === 'searxng') {
      const ct = r.headers.get('content-type') ?? '';
      if (!ct.toLowerCase().includes('json')) {
        res.json({
          ok: false,
          error: 'instance returned HTML — enable JSON output (formats: [html, json] in settings.yml).',
        });
        return;
      }
      const payload = await r.json() as { results?: unknown };
      const count = Array.isArray(payload?.results) ? payload.results.length : 0;
      res.json({ ok: true, count });
      return;
    }
    // ollama
    const payload = await r.json() as { models?: unknown };
    const count = Array.isArray(payload?.models) ? payload.models.length : 0;
    res.json({ ok: true, count });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      res.json({ ok: false, error: 'timeout' });
      return;
    }
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}
