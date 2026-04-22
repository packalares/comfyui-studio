// Gallery listing — flat array of every generated output the server knows
// about, backed by the `gallery` sqlite table. Rows land exclusively on
// `execution_complete` WS events (see `services/gallery.service.ts`) or
// via the explicit "Import from ComfyUI history" endpoint below. Fails
// open to an empty list so the dashboard still renders when ComfyUI is
// unreachable.
//
// Delete endpoints:
//   DELETE /api/gallery/:id           → single delete; 404 when the id is unknown.
//   DELETE /api/gallery               → bulk delete; body `{ ids: string[] }`.
// Import + regenerate endpoints (Wave F):
//   POST /api/gallery/import-from-comfyui → one-shot pull from /api/history.
//   POST /api/gallery/:id/regenerate      → re-submit the captured workflow.
// All routes are dual-mounted under `/launcher/gallery/...` per the existing
// alias pattern. Successful mutations trigger a `gallery` WS broadcast via
// `setGalleryBroadcaster` in `services/gallery.service.ts`.

import { Router, type Request, type Response } from 'express';
import * as gallery from '../services/gallery.service.js';
import { submitPrompt } from '../services/comfyui.js';
import { schedulePromptWatch } from '../services/gallery.sentry.js';
import { parsePageQuery } from '../lib/pagination.js';
import { randomizeStoredSeeds, type ApiPrompt } from '../services/gallery.extract.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get(['/gallery', '/launcher/gallery'], async (req: Request, res: Response) => {
  const pq = parsePageQuery(req, { defaultPageSize: 50, maxPageSize: 200 });

  if (!pq.isPaginated) {
    try { res.json(await gallery.list()); }
    catch { res.json([]); }
    return;
  }

  // Optional media-type filter, applied globally before pagination so pages
  // match the sidebar state. `sort=oldest` reverses the default ComfyUI order
  // (which is newest-first). Favourites stay client-side (localStorage).
  const media = typeof req.query.mediaType === 'string' ? req.query.mediaType : '';
  const sort = typeof req.query.sort === 'string' && req.query.sort === 'oldest'
    ? 'oldest' : 'newest';

  try {
    const { items, total } = await gallery.listPaginated(
      { mediaType: media, sort }, pq.page, pq.pageSize,
    );
    const totalPages = total === 0 ? 1 : Math.ceil(total / pq.pageSize);
    const safePage = Math.min(Math.max(1, pq.page), totalPages);
    const start = (safePage - 1) * pq.pageSize;
    res.json({
      items,
      page: safePage,
      pageSize: pq.pageSize,
      total,
      hasMore: start + items.length < total,
    });
  } catch {
    res.json({ items: [], page: 1, pageSize: pq.pageSize, total: 0, hasMore: false });
  }
});

/**
 * Wave P: single-row detail with fat generation metadata. Returns the full
 * row (`workflowJson`, `promptText`, KSampler params) so the detail modal
 * can render the metadata panel + drive the regenerate button. The list
 * endpoint above trimmed these fields from its rows to shrink the wire
 * payload — this route is the counterpart that restores them on demand.
 */
router.get(['/gallery/:id', '/launcher/gallery/:id'], (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const row = gallery.getByIdFull(id);
  if (!row) {
    res.status(404).json({ error: 'not_found', id });
    return;
  }
  res.json(row);
});

// Bulk delete. Mounted BEFORE the `:id` route so Express matches the bare
// collection path first. Body: `{ ids: string[] }`. Returns per-id results so
// the client can show partial-success state.
router.delete(['/gallery', '/launcher/gallery'], (req: Request, res: Response) => {
  const raw = (req.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(raw.ids) || raw.ids.length === 0) {
    res.status(400).json({ error: 'ids required (non-empty string[])' });
    return;
  }
  const ids: string[] = [];
  for (const v of raw.ids) {
    if (typeof v !== 'string' || v.length === 0) {
      res.status(400).json({ error: 'ids must be non-empty strings' });
      return;
    }
    ids.push(v);
  }
  const results = gallery.removeItems(ids);
  const deletedCount = results.filter(r => r.removed).length;
  res.json({
    deleted: deletedCount,
    requested: ids.length,
    results,
  });
});

router.delete(['/gallery/:id', '/launcher/gallery/:id'], (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const result = gallery.removeItem(id);
  if (!result.removed) {
    res.status(404).json({ deleted: false, id, error: result.error ?? 'not-found' });
    return;
  }
  res.json({ deleted: true, id, fileDeleted: result.fileDeleted });
});

// ---------------------------------------------------------------------------
// Wave F endpoints: explicit history import + regenerate.

// In-memory single-process rate-limit gate for the import endpoint. 10s
// between successful kickoffs so users can't hammer /api/history. Not
// cluster-safe — matches the rest of the in-memory limiters in this app.
const IMPORT_COOLDOWN_MS = 10_000;
let lastImportAt = 0;

router.post(
  ['/gallery/import-from-comfyui', '/launcher/gallery/import-from-comfyui'],
  async (_req: Request, res: Response) => {
    const now = Date.now();
    const remaining = lastImportAt + IMPORT_COOLDOWN_MS - now;
    if (remaining > 0) {
      res.setHeader('Retry-After', String(Math.ceil(remaining / 1000)));
      res.status(429).json({
        error: 'rate_limit',
        detail: 'import cooldown active',
      });
      return;
    }
    lastImportAt = now;
    try {
      const result = await gallery.syncFromComfyUI();
      res.json(result);
    } catch (err) {
      logger.warn('gallery import failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({ error: 'import_failed' });
    }
  },
);

router.post(
  ['/gallery/:id/regenerate', '/launcher/gallery/:id/regenerate'],
  async (req: Request, res: Response) => {
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ error: 'id required' });
      return;
    }
    const row = gallery.getById(id);
    if (!row) {
      res.status(404).json({ error: 'not_found', id });
      return;
    }
    if (!row.workflowJson) {
      res.status(422).json({
        error: 'WORKFLOW_MISSING',
        message:
          'This item was imported before workflow capture was enabled. ' +
          'Re-import from ComfyUI history to enable regenerate.',
      });
      return;
    }
    let workflow: ApiPrompt;
    try {
      workflow = JSON.parse(row.workflowJson) as ApiPrompt;
    } catch {
      res.status(422).json({
        error: 'WORKFLOW_INVALID',
        message: 'Stored workflow JSON could not be parsed.',
      });
      return;
    }
    const body = (req.body ?? {}) as { randomizeSeed?: unknown };
    if (body.randomizeSeed === true) {
      randomizeStoredSeeds(workflow);
    }
    try {
      const result = await submitPrompt(workflow as Record<string, unknown>);
      // Belt-and-suspenders: poll history in case the WS event path misses
      // the completion while ComfyUI restarts mid-run.
      if (result.prompt_id) schedulePromptWatch(result.prompt_id);
      res.json({ promptId: result.prompt_id });
    } catch (err) {
      logger.warn('gallery regenerate submit failed', {
        id,
        message: err instanceof Error ? err.message : String(err),
      });
      res.status(502).json({
        error: 'QUEUE_FAILED',
        message: err instanceof Error ? err.message : 'Queue submission failed',
      });
    }
  },
);

export default router;
