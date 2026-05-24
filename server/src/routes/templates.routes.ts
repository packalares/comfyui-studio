// Template listing, single-template fetch, and raw workflow-JSON proxy.
// Thumbnails served by /api/thumbnail/template/* (thumbnail.routes.ts).
// Per-template readiness (`ready: boolean`) from sqlite `templates.installed`.
// `?ready=yes|no|all` filters the paginated list.
//
// All data is read directly from SQLite (DB-first); there is no in-memory cache.

import { Router, type Request, type Response } from 'express';
import * as templateRepo from '../lib/db/templates.repo.js';
import type { TemplateListFilter } from '../lib/db/templates.filter.js';
import * as settings from '../services/settings/index.js';
import { sendError } from '../middleware/errors.js';
import { parsePageQuery } from '../lib/pagination.js';
import { handleImportCivitai, handleDeleteTemplate } from './templates.import.js';
import { runImportFromComfy } from '../services/templates/importFromComfy.js';
import * as templates from '../services/templates/index.js';
import { env } from '../config/env.js';
import type { TemplateListRow } from '../lib/db/templates.repo.js';
import { deriveStudioCategory } from '../services/templates/categoryMap.js';

const router = Router();

// Full Template shape used by both `/templates` (paginated Explore grid)
// and `/templates/list` (the slim bootstrap fetched once at app load).
// `displayName` is duplicated under `title` because Explore cards / the
// ModelDropdown / TemplateCard all read `t.title`; consumers of the slim
// list only touch a handful of fields, so the wire-size overhead is
// negligible at ~400 rows. Includes thumbnail (parsed from JSON) + the
// per-row ready flag (joined from the `installed` column).
function rowToTemplate(t: TemplateListRow): Record<string, unknown> {
  let thumbnail: string[] = [];
  if (t.thumbnail_json) {
    try {
      const parsed = JSON.parse(t.thumbnail_json) as unknown;
      if (Array.isArray(parsed)) thumbnail = parsed.filter((x): x is string => typeof x === 'string');
    } catch { /* leave empty */ }
  }
  return {
    name: t.name,
    title: t.displayName,
    displayName: t.displayName,
    description: t.description ?? '',
    category: t.category ?? '',
    studioCategory: deriveStudioCategory(t.media_type, t.category),
    mediaType: t.media_type ?? 'image',
    tags: t.tags ?? [],
    models: t.models ?? [],
    plugins: t.plugins ?? [],
    thumbnail,
    openSource: t.open_source !== 0,
    username: t.username ?? undefined,
    searchRank: t.search_rank ?? 0,
    favorite: t.favorite === true || (t.favorite as unknown) === 1,
    ready: t.installed === true || (t.installed as unknown) === 1,
    source_type: t.source_type ?? 0,
  };
}

// ---- Routes ----

// Slim list — CatalogContext caches this shape; Studio fetches the per-template
// bundle when a name is picked. No heavy fields — no workflow JSON, formInputs, etc.
router.get('/templates/list', (_req: Request, res: Response) => {
  const hasApiKey = settings.isApiKeyConfigured();
  // With a key the slim list is everything; without one we hide API-only
  // catalog templates but keep imports visible (same semantics as the
  // paginated `/templates` endpoint's `all` mapping).
  const filter: TemplateListFilter = hasApiKey ? {} : { source: 'visible' };
  // Large cap — list endpoint returns all, no pagination needed at this level.
  const result = templateRepo.listPaginated(filter, 1, 100_000);
  // Use the shared row→Template mapper. Slim consumers (ModelDropdown,
  // CatalogContext) only read .title / .name / .mediaType / .tags / .models,
  // but emitting the full Template shape keeps both endpoints consistent and
  // lets the slim list be used as a drop-in elsewhere without surprises.
  res.json(result.items.map(rowToTemplate));
});

// Paginated full objects for the Explore grid.
router.get('/templates', (req: Request, res: Response) => {
  const pq = parsePageQuery(req, { defaultPageSize: 50, maxPageSize: 200 });

  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase().trim() : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const sourceParam = typeof req.query.source === 'string' ? req.query.source : '';
  const tagsRaw = typeof req.query.tags === 'string' ? req.query.tags : '';
  const tags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const readyParam = typeof req.query.ready === 'string' ? req.query.ready : 'all';
  const readyFilter: 'yes' | 'no' | 'all' =
    readyParam === 'yes' || readyParam === 'no' ? readyParam : 'all';

  const hasApiKey = settings.isApiKeyConfigured();

  // Map source query param to filter value.
  let source: TemplateListFilter['source'] = 'all';
  if (sourceParam === 'open') source = 'open';
  else if (sourceParam === 'api') source = 'api';
  else if (sourceParam === 'user') source = 'user';
  else if (sourceParam === 'favorites') source = 'favorites';

  // When no API key, "All" maps to `visible` — open comfy templates plus
  // the user's own imports. Without this, `all` either includes API-only
  // templates the user can't run (with no key) or — under the old `open`
  // remap — drops imports entirely. `visible` is the union of both.
  const effectiveSource: TemplateListFilter['source'] =
    !hasApiKey && source === 'all' ? 'visible' : source;

  const filter: TemplateListFilter = {
    q: q || undefined,
    category: category || undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    source: effectiveSource,
    ready: readyFilter,
  };

  const result = templateRepo.listPaginated(filter, pq.page, pq.pageSize);
  res.json({
    items: result.items.map(rowToTemplate),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    hasMore: result.hasMore,
  });
});

// One-shot import of every workflow from ComfyUI's catalog.
// Streams SSE events: { type: "progress" | "skip" | "done" | "error" }.
// Uses GET so the browser's native EventSource can connect.
router.get('/templates/import-from-comfy', (req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable Nagle buffering so each event flushes immediately.
  if (typeof (res.socket as { setNoDelay?: (v: boolean) => void } | null)?.setNoDelay === 'function') {
    (res.socket as { setNoDelay: (v: boolean) => void }).setNoDelay(true);
  }

  const comfyUrl = env.COMFYUI_URL;

  function sendEvent(event: object): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
      (res as unknown as { flush: () => void }).flush();
    }
  }

  runImportFromComfy(comfyUrl, sendEvent)
    .catch((err) => {
      sendEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      res.end();
    });
});

// Import a CivitAI workflow version as a user template; DELETE for user-imported templates.
router.post('/templates/import-civitai', handleImportCivitai);
router.delete('/templates/:name', handleDeleteTemplate);

// Pin / unpin a template (the "favorite" star on the Explore card). Body:
// `{ favorite: boolean }`. 404 when the template has no sqlite row yet.
router.patch('/templates/:name/favorite', (req: Request, res: Response): void => {
  const name = req.params.name as string;
  const favorite = (req.body as { favorite?: unknown } | undefined)?.favorite === true;
  if (!templateRepo.setFavorite(name, favorite)) {
    res.status(404).json({ error: `Template not found: ${name}` });
    return;
  }
  res.json({ name, favorite });
});

// Queue installs for every plugin the template requires that isn't on disk.
const handleInstallMissingPlugins = async (req: Request, res: Response): Promise<void> => {
  try {
    const name = req.params.name as string;
    const result = await templates.installMissingPluginsForTemplate(name);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) {
      res.status(404).json({ error: msg });
      return;
    }
    sendError(res, err, 500, 'Install missing plugins failed');
  }
};
router.post('/templates/:name/install-missing-plugins', handleInstallMissingPlugins);

export default router;
