// Template listing + single-template fetch + raw workflow-JSON proxy. Driven
// by ComfyUI's /templates/* endpoint on the upstream; we add caching and
// API-key gating. Template thumbnails are served by the unified thumbnail
// service at `/api/thumbnail/template/*` (see thumbnail.routes.ts) — this
// file no longer hosts a `/template-asset/*` proxy.
//
// Phase 10: per-template readiness (`ready: boolean`) is sourced from the
// sqlite `templates.installed` column and attached to every returned item.
// `?ready=yes|no|all` filters the paginated list.

import { Router, type Request, type Response } from 'express';
import * as templates from '../services/templates/index.js';
import * as settings from '../services/settings.js';
import { findTemplatesByModelSubstring } from '../lib/db/templates.repo.js';
import { env } from '../config/env.js';
import { sendError } from '../middleware/errors.js';
import { parsePageQuery, paginate } from '../lib/pagination.js';
import { attachReady } from './templates.overlay.js';
import { handleImportCivitai, handleDeleteTemplate } from './templates.importCivitai.js';

const COMFYUI_URL = env.COMFYUI_URL;

const router = Router();

/** Slim wire shape for `/templates/list` and `/templates/stats`-adjacent
 *  consumers — drops the heavy fields (workflow, formInputs, io, models,
 *  plugins) so app-boot and picker dropdowns aren't shipping per-template
 *  workflow JSONs. Pages that need the full object call
 *  `/template-bundle/:name` on demand. */
function toTemplateSummary(t: ReturnType<typeof templates.getTemplates>[number]) {
  return {
    name: t.name,
    title: t.title,
    category: t.category,
    studioCategory: t.studioCategory,
    mediaType: t.mediaType,
    tags: t.tags,
    models: t.models,
    openSource: t.openSource,
  };
}

function visibleTemplates() {
  const all = templates.getTemplates();
  return settings.isApiKeyConfigured()
    ? all
    : all.filter(t => t.openSource !== false);
}

// Slim list — replaces the prior bare `/api/templates` bootstrap fetch. The
// CatalogContext caches THIS shape and Studio fetches the canonical
// per-template bundle when a name is picked.
router.get('/templates/list', async (_req: Request, res: Response) => {
  try { await templates.loadTemplatesFromComfyUI(COMFYUI_URL); } catch { /* serve stale */ }
  // No `attachReady` — the slim shape doesn't ship `ready`, so skip the
  // sqlite join. Pages that need readiness call the full paginated endpoint.
  res.json(visibleTemplates().map(toTemplateSummary));
});

// Templates — always paginated. The unpaginated full-list path was removed;
// every consumer uses either `/templates/list` (slim summaries) or
// `/templates?page=…` (paginated full objects for the Explore grid).
// When no Comfy Org API key is configured, API-node workflows are hidden
// site-wide via `visibleTemplates()`.
router.get('/templates', async (req: Request, res: Response) => {
  try {
    await templates.loadTemplatesFromComfyUI(COMFYUI_URL);
  } catch {
    // serve cached or empty
  }
  const result = visibleTemplates();
  const pq = parsePageQuery(req, { defaultPageSize: 50, maxPageSize: 200 });

  // Apply category + search + tag + source + ready filters globally before
  // slicing so pagination is consistent with the sidebar state.
  const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase().trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const source = typeof req.query.source === 'string' ? req.query.source : '';
  const tagsRaw = typeof req.query.tags === 'string' ? req.query.tags : '';
  const tags = tagsRaw ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const readyParam = typeof req.query.ready === 'string' ? req.query.ready : 'all';
  const readyFilter: 'yes' | 'no' | 'all' =
    readyParam === 'yes' || readyParam === 'no' ? readyParam : 'all';

  let rows = attachReady(result);
  if (source === 'open') rows = rows.filter((t) => t.openSource !== false);
  else if (source === 'api') rows = rows.filter((t) => t.openSource === false);
  // `source=user` keeps only user-imported workflows — the marker is the
  // category label assigned by `saveUserWorkflow`.
  else if (source === 'user') rows = rows.filter((t) => t.category === 'User Workflows');
  if (category && category !== 'All') {
    rows = rows.filter((t) => t.category === category);
  }
  if (tags.length > 0) {
    rows = rows.filter((t) => tags.some((tag) => t.tags.includes(tag)));
  }
  if (readyFilter === 'yes') rows = rows.filter((t) => t.ready);
  else if (readyFilter === 'no') rows = rows.filter((t) => !t.ready);
  if (q) {
    // Also pull template names from sqlite's `template_models` whose model
    // filename matches the needle. The in-memory `t.models` only carries
    // upstream-index-declared files; the sqlite side table is workflow-
    // parsed and covers every reference (e.g. `mistral_3_small_flux2_bf16`
    // lives in sqlite but not in the in-memory list).
    const modelMatchNames = new Set(findTemplatesByModelSubstring(q));
    rows = rows.filter((t) =>
      t.title.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      (t.category || '').toLowerCase().includes(q) ||
      (t.username || '').toLowerCase().includes(q) ||
      t.models.some((m) => m.toLowerCase().includes(q)) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
      modelMatchNames.has(t.name),
    );
  }
  res.json(paginate(rows, pq.page, pq.pageSize));
});

// Templates refresh — re-pull from ComfyUI + re-extract deps + recompute
// readiness. Returns the diff summary so the UI can surface "Added N /
// Updated M / Removed K" without a second fetch.
const handleRefresh = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await templates.refreshTemplates();
    res.json(result);
  } catch (err) {
    sendError(res, err, 500, 'Template refresh failed');
  }
};
router.post('/templates/refresh', handleRefresh);

// Import a CivitAI workflow version as a user template; plus DELETE on
// user-imported templates. Handlers live in `templates.importCivitai.ts`
// to keep this file under the structure line cap.
router.post('/templates/import-civitai', handleImportCivitai);
router.delete('/templates/:name', handleDeleteTemplate);

// Queue installs for every plugin the template requires that isn't already
// on disk. Returns the task ids so the UI can subscribe to
// `/plugins/progress/:taskId` for each one. See
// `server/src/services/templates/installMissingPlugins.ts`.
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
