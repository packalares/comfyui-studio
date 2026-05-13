// Template listing, single-template fetch, and raw workflow-JSON proxy.
// Thumbnails served by /api/thumbnail/template/* (thumbnail.routes.ts).
// Per-template readiness (`ready: boolean`) from sqlite `templates.installed`.
// `?ready=yes|no|all` filters the paginated list.

import { Router, type Request, type Response } from 'express';
import * as templates from '../services/templates/index.js';
import * as settings from '../services/settings/index.js';
import { findTemplatesByModelSubstring } from '../lib/db/templates.repo.js';
import * as templateRepo from '../lib/db/templates.repo.js';
import { env } from '../config/env.js';
import { sendError } from '../middleware/errors.js';
import { parsePageQuery, paginate } from '../lib/pagination.js';
import {
  isPluginInstalled, getInstalledPluginKeys,
} from '../services/plugins/cache.js';
import { normalizeRepoKey } from '../services/plugins/nodes.js';
import type { TemplateData, TemplatePluginEntry } from '../services/templates/index.js';
import { handleImportCivitai, handleDeleteTemplate } from './templates.import.js';

const COMFYUI_URL = env.COMFYUI_URL;

const router = Router();

// ---- attachReady helpers ----

export interface TemplateWithReady extends TemplateData {
  ready: boolean;
  favorite: boolean;
}

// ComfyUI core node types surface as these repo keys from Manager.
// They ship with ComfyUI so they are neither "missing" nor installable.
const BUILTIN_PLUGIN_KEYS = new Set<string>([
  'comfy-core',
  'comfyanonymous/comfyui',
  'comfyui',
]);

interface TemplateFlags { ready: boolean; favorite: boolean; }

function loadTemplateFlags(): Map<string, TemplateFlags> {
  const map = new Map<string, TemplateFlags>();
  try {
    const { items, total } = templateRepo.listPaginated({ ready: 'all' }, 1, 100_000);
    for (const row of items) map.set(row.name, { ready: row.installed, favorite: row.favorite });
    if (total > items.length) return map; // paranoia cap
  } catch {
    /* db unavailable => empty map => ready:false / favorite:false for all */
  }
  return map;
}

function overlayPluginInstalled(
  plugins: TemplatePluginEntry[] | undefined,
  keys: ReturnType<typeof getInstalledPluginKeys>,
): TemplatePluginEntry[] | undefined {
  if (!plugins || plugins.length === 0) return plugins;
  return plugins
    .map((p) => ({ entry: p, key: normalizeRepoKey(p.repo || '') }))
    .filter(({ key }) => key.length > 0 && !BUILTIN_PLUGIN_KEYS.has(key))
    .map(({ entry, key }) => {
      // Try repo key, cnr_id alias, and directory-existence probe — covers
      // every form a workflow might persist.
      let isInstalled = isPluginInstalled(key, keys);
      if (!isInstalled && entry.cnr_id) {
        isInstalled = isPluginInstalled(entry.cnr_id, keys);
      }
      return { ...entry, installed: isInstalled };
    });
}

export function attachReady(list: TemplateData[]): TemplateWithReady[] {
  const flags = loadTemplateFlags();
  const installedKeys = getInstalledPluginKeys();
  return list.map((t) => ({
    ...t,
    ready: flags.get(t.name)?.ready ?? false,
    favorite: flags.get(t.name)?.favorite ?? false,
    plugins: overlayPluginInstalled(t.plugins, installedKeys),
  }));
}

// ---- Route helpers ----

/** Slim wire shape for `/templates/list` — drops heavy fields so app-boot and
 *  picker dropdowns don't ship per-template workflow JSONs. */
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

// ---- Routes ----

// Slim list — CatalogContext caches this shape; Studio fetches the per-template
// bundle when a name is picked. No `attachReady` — slim shape doesn't ship `ready`.
router.get('/templates/list', async (_req: Request, res: Response) => {
  try { await templates.loadTemplatesFromComfyUI(COMFYUI_URL); } catch { /* serve stale */ }
  res.json(visibleTemplates().map(toTemplateSummary));
});

// Paginated full objects for the Explore grid.
router.get('/templates', async (req: Request, res: Response) => {
  try {
    await templates.loadTemplatesFromComfyUI(COMFYUI_URL);
  } catch {
    // serve cached or empty
  }
  const result = visibleTemplates();
  const pq = parsePageQuery(req, { defaultPageSize: 50, maxPageSize: 200 });

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
  // `source=user` keeps only user-imported workflows — marker is the category label.
  else if (source === 'user') rows = rows.filter((t) => t.category === 'User Workflows');
  // `source=favorites` keeps only the user-pinned templates.
  else if (source === 'favorites') rows = rows.filter((t) => t.favorite);
  if (category && category !== 'All') {
    rows = rows.filter((t) => t.category === category);
  }
  if (tags.length > 0) {
    rows = rows.filter((t) => tags.some((tag) => t.tags.includes(tag)));
  }
  if (readyFilter === 'yes') rows = rows.filter((t) => t.ready);
  else if (readyFilter === 'no') rows = rows.filter((t) => !t.ready);
  if (q) {
    // sqlite `template_models` covers workflow-parsed model references not
    // in the in-memory list (e.g. `mistral_3_small_flux2_bf16`).
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

// Re-pull from ComfyUI + re-extract deps + recompute readiness.
const handleRefresh = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await templates.refreshTemplates();
    res.json(result);
  } catch (err) {
    sendError(res, err, 500, 'Template refresh failed');
  }
};
router.post('/templates/refresh', handleRefresh);

// Import a CivitAI workflow version as a user template; DELETE for user-imported templates.
router.post('/templates/import-civitai', handleImportCivitai);
router.delete('/templates/:name', handleDeleteTemplate);

// Pin / unpin a template (the "favorite" star on the Explore card). Body:
// `{ favorite: boolean }`. 404 when the template has no sqlite row yet (a
// just-appeared upstream entry — a `/templates/refresh` seeds it).
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
