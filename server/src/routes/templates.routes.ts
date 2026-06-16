// Template listing, single-template fetch, and raw workflow-JSON proxy.
// Thumbnails served by /api/thumbnail/template/* (thumbnail.routes.ts).
// SSE import-from-comfy kept as raw Express handler (streams, no body envelope).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError } from '../lib/errors.js';
import * as templateRepo from '../lib/db/templates.repo.js';
import type { TemplateListFilter } from '../lib/db/templates.filter.js';
import * as settings from '../services/settings/index.js';
import { parsePageQuery } from '../lib/pagination.js';
import { handleImportCivitai, handleDeleteTemplate } from './templates.import.js';
import { runImportFromComfy } from '../services/templates/importFromComfy.js';
import * as templates from '../services/templates/index.js';
import { env } from '../config/env.js';
import type { TemplateListRow } from '../lib/db/templates.repo.js';
import { deriveStudioCategory } from '../services/templates/categoryMap.js';
import { TemplateParamsSchema, FavoritePatchSchema, TemplateFavoriteResponseSchema } from '../contracts/templates.contract.js';

// ---- Row mapper ----

/**
 * Build a {name → studioBuilder} lookup from the on-disk user-template files.
 * `studioBuilder` lives in the TemplateData JSON, not in the templates DB row,
 * so we read it here and splice it into the response — without this, the
 * VideoBuilder / ImageBuilder filters that key off `studioBuilder` see undefined
 * for every entry and either show nothing (strict filter) or show the entire
 * catalog (permissive fallback). Cheap: one fs scan per list request.
 */
function userStudioBuilderMap(): Map<string, 'image' | 'video' | 'audio'> {
  const map = new Map<string, 'image' | 'video' | 'audio'>();
  try {
    for (const t of templates.listUserWorkflows()) {
      if (t.studioBuilder) map.set(t.name, t.studioBuilder);
    }
  } catch { /* ignore — empty map is a safe default */ }
  return map;
}

function rowToTemplate(
  t: TemplateListRow,
  studioBuilderByName?: Map<string, 'image' | 'video' | 'audio'>,
): Record<string, unknown> {
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
    studioBuilder: studioBuilderByName?.get(t.name),
  };
}

const TemplateArraySchema = z.array(z.record(z.string(), z.unknown()));
const PagedTemplatesSchema = z.object({
  items: TemplateArraySchema,
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
});

// ---- Routes ----

const listRoute = defineRoute({
  method: 'GET',
  path: '/templates/list',
  response: TemplateArraySchema,
  auth: { required: false },
  tags: ['templates'],
  summary: 'Slim template list for bootstrap (CatalogContext)',
}, ({ ok }) => {
  const hasApiKey = settings.isApiKeyConfigured();
  const filter: TemplateListFilter = hasApiKey ? {} : { source: 'visible' };
  const result = templateRepo.listPaginated(filter, 1, 100_000);
  const studioBuilderByName = userStudioBuilderMap();
  return ok(result.items.map((row) => rowToTemplate(row, studioBuilderByName)));
});

const pagedRoute = defineRoute({
  method: 'GET',
  path: '/templates',
  query: z.object({
    page: z.coerce.number().int().positive().optional(),
    pageSize: z.coerce.number().int().positive().optional(),
    q: z.string().optional(),
    category: z.string().optional(),
    tags: z.string().optional(),
    source: z.enum(['all', 'open', 'api', 'user', 'favorites']).optional(),
    ready: z.enum(['all', 'yes', 'no']).optional(),
  }),
  response: PagedTemplatesSchema,
  auth: { required: false },
  tags: ['templates'],
  summary: 'Paginated templates for Explore grid',
}, ({ query, ok, req }) => {
  const pq = parsePageQuery(req, { defaultPageSize: 50, maxPageSize: 200 });
  const hasApiKey = settings.isApiKeyConfigured();

  const tags = query.tags ? query.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const source = query.source ?? 'all';
  const effectiveSource: TemplateListFilter['source'] =
    !hasApiKey && source === 'all' ? 'visible' : source;
  const readyFilter: 'yes' | 'no' | 'all' =
    query.ready === 'yes' || query.ready === 'no' ? query.ready : 'all';

  const filter: TemplateListFilter = {
    q: query.q?.toLowerCase().trim() || undefined,
    category: query.category || undefined,
    tags: tags && tags.length > 0 ? tags : undefined,
    source: effectiveSource,
    ready: readyFilter,
  };

  const result = templateRepo.listPaginated(filter, pq.page, pq.pageSize);
  const studioBuilderByName = userStudioBuilderMap();
  return ok({
    items: result.items.map((row) => rowToTemplate(row, studioBuilderByName)),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    hasMore: result.hasMore,
  });
});

const patchFavoriteRoute = defineRoute({
  method: 'PATCH',
  path: '/templates/:name/favorite',
  params: TemplateParamsSchema,
  body: FavoritePatchSchema,
  response: TemplateFavoriteResponseSchema,
  auth: { required: true, scopes: ['catalog:write'] },
  tags: ['templates'],
  summary: 'Pin or unpin a template',
}, ({ params, body, ok }) => {
  if (!templateRepo.setFavorite(params.name, body.favorite)) {
    throw new NotFoundError(`Template not found: ${params.name}`);
  }
  return ok({ name: params.name, favorite: body.favorite });
});

const installMissingPluginsRoute = defineRoute({
  method: 'POST',
  path: '/templates/:name/install-missing-plugins',
  params: TemplateParamsSchema,
  response: z.unknown(),
  auth: { required: true, scopes: ['catalog:write'] },
  tags: ['templates'],
  summary: 'Queue installs for every plugin the template requires',
}, async ({ params, ok }) => {
  const result = await templates.installMissingPluginsForTemplate(params.name);
  return ok(result);
});

// ---- SSE route (raw — must stream, cannot use defineRoute envelope) ----

const router = Router();
listRoute.register(router);
pagedRoute.register(router);

// SSE: import all workflows from ComfyUI. Kept raw — streams events.
router.get('/templates/import-from-comfy', (req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof (res.socket as { setNoDelay?: (v: boolean) => void } | null)?.setNoDelay === 'function') {
    (res.socket as { setNoDelay: (v: boolean) => void }).setNoDelay(true);
  }
  function sendEvent(event: object): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
      (res as unknown as { flush: () => void }).flush();
    }
  }
  runImportFromComfy(env.COMFYUI_URL, sendEvent)
    .catch((err) => { sendEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) }); })
    .finally(() => { res.end(); });
});

router.post('/templates/import-civitai', handleImportCivitai);
router.delete('/templates/:name', handleDeleteTemplate);

patchFavoriteRoute.register(router);
installMissingPluginsRoute.register(router);

export default router;
