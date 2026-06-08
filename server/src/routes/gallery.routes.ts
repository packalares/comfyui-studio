// Gallery routes — list, detail, delete, favorite, import, regenerate.
// Successful mutations trigger a WS `gallery` broadcast via the service.

import { Router } from 'express';
import { z } from 'zod';
import * as gallery from '../services/gallery/index.js';
import { submitPrompt } from '../services/comfyui/api.js';
import { schedulePromptWatch } from '../services/gallery/sentry.js';
import { insertSnapshot } from '../lib/db/promptSnapshots.repo.js';
import { parsePageQuery, splitPaginated, paginate } from '../lib/pagination.js';
import { randomizeStoredSeeds, extractMetadata, type ApiPrompt } from '../services/gallery/extract.js';
import type { WorkflowDetail } from '../contracts/generation.contract.js';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError, RateLimitError, HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  GalleryListItemSchema,
  GalleryItemSchema,
  GalleryPageResponseSchema,
  GalleryByPromptIdsResponseSchema,
  GalleryFavoriteResponseSchema,
  GalleryDeleteResultSchema,
  GalleryBulkDeleteResponseSchema,
  GalleryImportResponseSchema,
  GalleryRegenerateResponseSchema,
  GalleryListQuerySchema,
  GalleryByPromptIdsQuerySchema,
  GalleryNeighborQuerySchema,
  GalleryIdParamsSchema,
  GalleryFavoritePatchSchema,
  GalleryBulkDeleteSchema,
  GalleryRegenerateBodySchema,
} from '../contracts/gallery.contract.js';

// Rate-limit gate for the import endpoint (single-process, non-cluster-safe).
const IMPORT_COOLDOWN_MS = 10_000;
let lastImportAt = 0;

// ---- Route definitions ----

const listRoute = defineRoute({
  method: 'GET',
  path: '/gallery',
  query: GalleryListQuerySchema,
  response: GalleryPageResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
  tags: ['gallery'],
  summary: 'List gallery items (paginated)',
}, async (ctx) => {
  const pq = parsePageQuery(ctx.req, { defaultPageSize: 50, maxPageSize: 200 });
  const media = ctx.query.mediaType ?? '';
  const sort = ctx.query.sort === 'oldest' ? 'oldest' : 'newest';
  const favorite = ctx.query.favorite === 'true' ? true : undefined;

  if (!pq.isPaginated) {
    // Back-compat: no ?page= → return everything wrapped as page 1.
    try {
      const items = await gallery.list();
      return ctx.ok({ items, page: 1, pageSize: items.length || 50, total: items.length, hasMore: false });
    } catch {
      return ctx.ok({ items: [], page: 1, pageSize: 50, total: 0, hasMore: false });
    }
  }

  try {
    const { items, total } = await gallery.listPaginated(
      { mediaType: media, sort, favorite }, pq.page, pq.pageSize,
    );
    const { meta } = splitPaginated(paginate(items, pq.page, pq.pageSize));
    // listPaginated already slices correctly; trust its total but re-derive meta.
    const totalPages = total === 0 ? 1 : Math.ceil(total / pq.pageSize);
    const safePage = Math.min(Math.max(1, pq.page), totalPages);
    const start = (safePage - 1) * pq.pageSize;
    return ctx.ok({
      items,
      page: safePage,
      pageSize: pq.pageSize,
      total,
      hasMore: start + items.length < total,
    });
  } catch {
    return ctx.ok({ items: [], page: 1, pageSize: pq.pageSize, total: 0, hasMore: false });
  }
});

const byPromptIdsRoute = defineRoute({
  method: 'GET',
  path: '/gallery/by-prompt-ids',
  query: GalleryByPromptIdsQuerySchema,
  response: GalleryByPromptIdsResponseSchema,
  auth: { required: true, scopes: ['gallery:read'] },
  tags: ['gallery'],
  summary: 'Bulk lookup by promptId (comma-separated ids)',
}, (ctx) => {
  const raw = ctx.query.ids ?? '';
  const ids = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  if (ids.length === 0) return ctx.ok({ items: [] });
  try {
    return ctx.ok({ items: gallery.listByPromptIds(ids) });
  } catch {
    return ctx.ok({ items: [] });
  }
});

const getByIdRoute = defineRoute({
  method: 'GET',
  path: '/gallery/:id',
  params: GalleryIdParamsSchema,
  query: GalleryNeighborQuerySchema,
  response: GalleryItemSchema,
  auth: { required: true, scopes: ['gallery:read'] },
  tags: ['gallery'],
  summary: 'Full gallery row with workflow detail and neighbor ids',
}, (ctx) => {
  const { id } = ctx.params;
  const row = gallery.getByIdFull(id);
  if (!row) throw new NotFoundError('Gallery item not found');

  const { workflowJson, workflowHash: _wfHash, ...rest } = row;
  let workflowDetail: WorkflowDetail | null = null;
  if (workflowJson) {
    try {
      const apiPrompt = JSON.parse(workflowJson) as ApiPrompt;
      const extracted = extractMetadata(apiPrompt);
      workflowDetail = {
        promptText:   extracted.promptText   ?? null,
        negativeText: extracted.negativeText ?? null,
        seed:         extracted.seed         ?? null,
        model:        extracted.model        ?? null,
        models:       extracted.models       ?? [],
        sampler:      extracted.sampler      ?? null,
        scheduler:    extracted.scheduler    ?? null,
        steps:        extracted.steps        ?? null,
        cfg:          extracted.cfg          ?? null,
        denoise:      extracted.denoise      ?? null,
        width:        extracted.width        ?? null,
        height:       extracted.height       ?? null,
        lengthFrames: extracted.length       ?? null,
        fps:          extracted.fps          ?? null,
        batchSize:    extracted.batchSize    ?? null,
      };
    } catch { /* malformed workflowJson */ }
  }

  const mediaType = ctx.query.mediaType ?? '';
  const sort = ctx.query.sort === 'oldest' ? 'oldest' : 'newest';
  const favParam = ctx.query.favorite === 'true' ? true : undefined;
  // NOTE(wave4): prevId/nextId are UI-hint fields that leak filter state into
  // the API row. They should move to a dedicated /gallery/:id/neighbors endpoint
  // in Wave 4 so the row schema is filter-independent.
  const { prevId, nextId } = gallery.findNeighborIds(id, { mediaType, sort, favorite: favParam });

  return ctx.ok({ ...rest, workflowDetail, prevId, nextId });
});

const patchFavoriteRoute = defineRoute({
  method: 'PATCH',
  path: '/gallery/:id/favorite',
  params: GalleryIdParamsSchema,
  body: GalleryFavoritePatchSchema,
  response: GalleryFavoriteResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['gallery'],
  summary: 'Pin / unpin a gallery item',
}, (ctx) => {
  const { id } = ctx.params;
  if (!gallery.setFavorite(id, ctx.body.favorite)) {
    throw new NotFoundError('Gallery item not found');
  }
  return ctx.ok({ id, favorite: ctx.body.favorite });
});

const bulkDeleteRoute = defineRoute({
  method: 'DELETE',
  path: '/gallery',
  body: GalleryBulkDeleteSchema,
  response: GalleryBulkDeleteResponseSchema,
  auth: { required: true, scopes: ['gallery:delete'] },
  tags: ['gallery'],
  summary: 'Bulk delete gallery items',
}, (ctx) => {
  const results = gallery.removeItems(ctx.body.ids);
  return ctx.ok({
    deleted:   results.filter(r => r.removed).length,
    requested: ctx.body.ids.length,
    results,
  });
});

const deleteByIdRoute = defineRoute({
  method: 'DELETE',
  path: '/gallery/:id',
  params: GalleryIdParamsSchema,
  response: GalleryDeleteResultSchema,
  auth: { required: true, scopes: ['gallery:delete'] },
  tags: ['gallery'],
  summary: 'Delete a single gallery item',
}, (ctx) => {
  const result = gallery.removeItem(ctx.params.id);
  if (!result.removed) throw new NotFoundError('Gallery item not found');
  return ctx.ok({ deleted: true, id: ctx.params.id, fileDeleted: result.fileDeleted });
});

const importFromComfyUIRoute = defineRoute({
  method: 'POST',
  path: '/gallery/import-from-comfyui',
  response: GalleryImportResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['gallery'],
  summary: 'One-shot import from ComfyUI history',
}, async (ctx) => {
  const now = Date.now();
  const remaining = lastImportAt + IMPORT_COOLDOWN_MS - now;
  if (remaining > 0) {
    ctx.res.setHeader('Retry-After', String(Math.ceil(remaining / 1000)));
    throw new RateLimitError('Import cooldown active');
  }
  lastImportAt = now;
  try {
    const result = await gallery.syncFromComfyUI();
    return ctx.ok(result as unknown as z.infer<typeof GalleryImportResponseSchema>);
  } catch (err) {
    logger.warn('gallery import failed', { message: err instanceof Error ? err.message : String(err) });
    throw new HttpError('upstream_unavailable', 'Import from ComfyUI failed');
  }
});

const regenerateRoute = defineRoute({
  method: 'POST',
  path: '/gallery/:id/regenerate',
  params: GalleryIdParamsSchema,
  body: GalleryRegenerateBodySchema,
  response: GalleryRegenerateResponseSchema,
  auth: { required: true, scopes: ['gallery:write'] },
  tags: ['gallery'],
  summary: 'Re-submit the stored workflow JSON for a gallery item',
}, async (ctx) => {
  const { id } = ctx.params;
  const row = gallery.getById(id);
  if (!row) throw new NotFoundError('Gallery item not found');
  if (!row.workflowJson) {
    throw new ValidationError(
      'This item was imported before workflow capture was enabled. Re-import from ComfyUI history to enable regenerate.',
    );
  }
  let workflow: ApiPrompt;
  try {
    workflow = JSON.parse(row.workflowJson) as ApiPrompt;
  } catch {
    throw new ValidationError('Stored workflow JSON could not be parsed.');
  }
  if (ctx.body.randomizeSeed === true) {
    randomizeStoredSeeds(workflow);
  }
  try {
    const result = await submitPrompt(workflow as Record<string, unknown>);
    if (result.prompt_id) {
      // Mirror generate.routes.ts: seed snapshot + meta so the gallery row that
      // lands later carries templateName / triggered_by / fingerprints instead
      // of nulling them out (the sentry → appendHistoryEntry path reads both).
      try {
        insertSnapshot({
          promptId: result.prompt_id,
          apiPromptJson: JSON.stringify(workflow),
          templateName: row.templateName ?? undefined,
          triggered_by: 'ui',
          conversation_id: null,
          message_id: null,
        });
      } catch { /* snapshot failure must not fail the submit */ }
      // modelFingerprint / templateHash aren't exposed on GalleryRowFull
      // (they're DB columns but not re-mapped in rowToFull). Leave them off
      // the watch options — the regenerated row will land with null
      // fingerprints, which is fine: workflowDetail derived from
      // workflowJson still drives the modal, and the fingerprints are only
      // used downstream for cache-hit dedup, which gracefully no-ops on null.
      schedulePromptWatch(result.prompt_id, {
        triggeredBy: 'ui',
        conversationId: null,
        messageId: null,
      });
    }
    return ctx.ok({ promptId: result.prompt_id });
  } catch (err) {
    logger.warn('gallery regenerate submit failed', {
      id, message: err instanceof Error ? err.message : String(err),
    });
    throw new HttpError('upstream_unavailable', err instanceof Error ? err.message : 'Queue submission failed');
  }
});

// ---- Mount ----
// Static sub-paths before /:id so Express matches them first.
const router = Router();
[
  listRoute,
  byPromptIdsRoute,
  importFromComfyUIRoute,
  getByIdRoute,
  patchFavoriteRoute,
  bulkDeleteRoute,
  deleteByIdRoute,
  regenerateRoute,
].forEach(r => r.register(router));

export default router;
