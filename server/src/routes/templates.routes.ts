// Template listing + single-template fetch + template asset proxy + raw
// workflow-JSON proxy. All driven by ComfyUI's /templates/* endpoint on the
// upstream; we simply add caching, API-key gating, and path sanitization.
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

// Reject any asset path segment containing '..' so a crafted request can't
// traverse outside of ComfyUI's templates directory even if the upstream's
// own guard is absent.
function isSafeAssetPath(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('/')) return false;
  return true;
}

// Templates — always fetch fresh from ComfyUI.
// When no Comfy Org API key is configured, hide API-node workflows entirely
// so they don't appear anywhere in the UI (Explore, Studio, model-dep filters).
router.get('/templates', async (req: Request, res: Response) => {
  try {
    await templates.loadTemplatesFromComfyUI(COMFYUI_URL);
  } catch {
    // will return cached or empty
  }
  const all = templates.getTemplates();
  const result = settings.isApiKeyConfigured()
    ? all
    : all.filter(t => t.openSource !== false);
  const pq = parsePageQuery(req, { defaultPageSize: 50, maxPageSize: 200 });
  if (!pq.isPaginated) {
    res.json(attachReady(result));
    return;
  }

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
router.post('/launcher/templates/refresh', handleRefresh);

router.get('/templates/:name', async (req: Request, res: Response) => {
  const name = req.params.name as string;
  const t = templates.getTemplate(name);
  if (!t) {
    res.status(404).json({ error: 'Template not found' });
    return;
  }
  // For user-imported workflows, re-compute `formInputs` against live
  // objectInfo so prompt textareas from custom-node classes that only
  // registered AFTER initial import (IndexTTS2 etc., which need weights
  // present before their __init__.py succeeds) become visible without
  // requiring a re-import.
  if (templates.isUserWorkflow(name)) {
    try {
      const { generateFormInputs } = await import('../services/templates/templates.formInputs.js');
      const { getObjectInfo } = await import('../services/workflow/index.js');
      const wf = templates.getUserWorkflowJson(name);
      if (wf) {
        const objectInfo = await getObjectInfo();
        const freshInputs = generateFormInputs(
          { name: t.name, title: t.title, description: t.description,
            mediaType: t.mediaType, tags: t.tags, models: t.models, io: t.io },
          wf,
          objectInfo,
        );
        res.json({ ...t, formInputs: freshInputs });
        return;
      }
    } catch {
      // Non-fatal: fall through to cached.
    }
  }
  res.json(t);
});

// Proxy template assets (thumbnails, input/output images) from ComfyUI.
router.get('/template-asset/*', async (req: Request, res: Response) => {
  try {
    const assetPath = req.params[0] as string;
    if (!isSafeAssetPath(assetPath)) {
      res.status(400).end();
      return;
    }
    const url = `${COMFYUI_URL}/templates/${assetPath}`;
    const response = await fetch(url);
    if (!response.ok) {
      res.status(response.status).end();
      return;
    }
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch {
    res.status(502).end();
  }
});

// Import a CivitAI workflow version as a user template; plus DELETE on
// user-imported templates. Handlers live in `templates.importCivitai.ts`
// to keep this file under the structure line cap.
router.post('/templates/import-civitai', handleImportCivitai);
router.post('/launcher/templates/import-civitai', handleImportCivitai);
router.delete('/templates/:name', handleDeleteTemplate);
router.delete('/launcher/templates/:name', handleDeleteTemplate);

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
router.post('/launcher/templates/:name/install-missing-plugins', handleInstallMissingPlugins);

// Raw workflow JSON proxy for clients that want to inspect the template's
// underlying LiteGraph document. User-imported workflows are served from
// the in-memory cache (their `workflow` field); upstream ones are proxied
// through ComfyUI's own `/templates/:name.json`.
router.get('/workflow/:name', async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    if (templates.isUserWorkflow(name)) {
      const t = templates.getTemplate(name);
      if (t?.workflow) {
        res.json(t.workflow);
        return;
      }
      res.status(404).json({ error: `Workflow not found: ${name}` });
      return;
    }
    const upstream = await fetch(
      `${COMFYUI_URL}/templates/${encodeURIComponent(name)}.json`
    );
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Workflow not found: ${name}` });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    sendError(res, err, 502, 'Cannot fetch workflow');
  }
});

export default router;
