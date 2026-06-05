// Typed wrappers for gallery routes.

import { z } from 'zod';
import { apiCall } from './client.js';
import type { GalleryItem } from '../types/index.js';

// ---- Inline schemas (mirrors gallery.contract.ts without runtime import) ----

const GalleryListItemSchema = z.object({
  id:            z.string(),
  filename:      z.string(),
  subfolder:     z.string(),
  type:          z.string(),
  mediaType:     z.string(),
  url:           z.string(),
  promptId:      z.string(),
  templateName:  z.string().nullable().optional(),
  sizeBytes:     z.number().nullable().optional(),
  createdAt:     z.number().optional(),
  jobDurationMs: z.number().nullable().optional(),
  favorite:      z.boolean().optional(),
}).passthrough();

const GalleryItemSchema = GalleryListItemSchema.extend({
  mediaDurationMs: z.number().nullable().optional(),
  mediaInfo:       z.record(z.string(), z.unknown()).nullable().optional(),
  workflowDetail:  z.object({
    promptText:   z.string().nullable(),
    negativeText: z.string().nullable(),
    seed:         z.number().nullable(),
    model:        z.string().nullable(),
    models:       z.array(z.string()),
    sampler:      z.string().nullable(),
    scheduler:    z.string().nullable(),
    steps:        z.number().nullable(),
    cfg:          z.number().nullable(),
    denoise:      z.number().nullable(),
    width:        z.number().nullable(),
    height:       z.number().nullable(),
    lengthFrames: z.number().nullable(),
    fps:          z.number().nullable(),
    batchSize:    z.number().nullable(),
  }).nullable().optional(),
  prevId: z.string().nullable().optional(),
  nextId: z.string().nullable().optional(),
}).passthrough();

const GalleryPageResponseSchema = z.object({
  items:    z.array(GalleryListItemSchema),
  page:     z.number(),
  pageSize: z.number(),
  total:    z.number(),
  hasMore:  z.boolean(),
});

const GalleryByPromptIdsResponseSchema = z.object({
  items: z.array(GalleryListItemSchema),
});

const GalleryFavoriteResponseSchema = z.object({
  id:       z.string(),
  favorite: z.boolean(),
});

const GalleryDeleteResultSchema = z.object({
  deleted:     z.boolean(),
  id:          z.string(),
  fileDeleted: z.boolean().optional(),
});

const GalleryBulkDeleteResponseSchema = z.object({
  deleted:   z.number(),
  requested: z.number(),
  results:   z.array(z.object({ id: z.string(), removed: z.boolean(), error: z.string().optional() })),
});

const GalleryImportResponseSchema = z.object({
  imported: z.number().optional(),
  skipped:  z.number().optional(),
  errors:   z.number().optional(),
}).passthrough();

const GalleryRegenerateResponseSchema = z.object({
  promptId: z.string().optional(),
}).passthrough();

// ---- Route specs ----

const listSpec = {
  method: 'GET' as const,
  path: '/gallery',
  query: z.object({
    page: z.string().optional(), pageSize: z.string().optional(),
    mediaType: z.string().optional(), sort: z.enum(['newest', 'oldest']).optional(),
    favorite: z.string().optional(),
  }),
  response: GalleryPageResponseSchema,
};

const byPromptIdsSpec = {
  method: 'GET' as const,
  path: '/gallery/by-prompt-ids',
  query: z.object({ ids: z.string().optional() }),
  response: GalleryByPromptIdsResponseSchema,
};

const getByIdSpec = {
  method: 'GET' as const,
  path: '/gallery/:id',
  params: z.object({ id: z.string() }),
  query: z.object({
    mediaType: z.string().optional(),
    sort: z.enum(['newest', 'oldest']).optional(),
    favorite: z.string().optional(),
  }),
  response: GalleryItemSchema,
};

const patchFavoriteSpec = {
  method: 'PATCH' as const,
  path: '/gallery/:id/favorite',
  params: z.object({ id: z.string() }),
  body: z.object({ favorite: z.boolean() }),
  response: GalleryFavoriteResponseSchema,
};

const bulkDeleteSpec = {
  method: 'DELETE' as const,
  path: '/gallery',
  body: z.object({ ids: z.array(z.string()) }),
  response: GalleryBulkDeleteResponseSchema,
};

const deleteByIdSpec = {
  method: 'DELETE' as const,
  path: '/gallery/:id',
  params: z.object({ id: z.string() }),
  response: GalleryDeleteResultSchema,
};

const importSpec = {
  method: 'POST' as const,
  path: '/gallery/import-from-comfyui',
  response: GalleryImportResponseSchema,
};

const regenerateSpec = {
  method: 'POST' as const,
  path: '/gallery/:id/regenerate',
  params: z.object({ id: z.string() }),
  body: z.object({ randomizeSeed: z.boolean().optional() }),
  response: GalleryRegenerateResponseSchema,
};

// ---- Public API ----

export async function getGalleryPaged(
  page: number,
  pageSize: number,
  opts: { mediaType?: string; sort?: 'newest' | 'oldest'; favorite?: boolean } = {},
) {
  const query: Record<string, string> = {
    page: String(page),
    pageSize: String(pageSize),
  };
  if (opts.mediaType && opts.mediaType !== 'all') query.mediaType = opts.mediaType;
  if (opts.sort && opts.sort !== 'newest') query.sort = opts.sort;
  if (opts.favorite) query.favorite = 'true';
  return apiCall(listSpec, { query });
}

export async function getGalleryByPromptIds(ids: string[]) {
  if (ids.length === 0) return { items: [] as GalleryItem[] };
  return apiCall(byPromptIdsSpec, { query: { ids: ids.join(',') } });
}

export async function getGalleryItem(
  id: string,
  opts: { mediaType?: string; sort?: 'newest' | 'oldest'; favorite?: boolean } = {},
) {
  const query: Record<string, string> = {};
  if (opts.mediaType && opts.mediaType !== 'all') query.mediaType = opts.mediaType;
  if (opts.sort && opts.sort !== 'newest') query.sort = opts.sort;
  if (opts.favorite) query.favorite = 'true';
  return apiCall(getByIdSpec, { params: { id }, query });
}

export async function setGalleryFavorite(id: string, favorite: boolean) {
  return apiCall(patchFavoriteSpec, { params: { id }, body: { favorite } });
}

export async function deleteGalleryItem(id: string) {
  return apiCall(deleteByIdSpec, { params: { id } });
}

export async function bulkDeleteGalleryItems(ids: string[]) {
  return apiCall(bulkDeleteSpec, { body: { ids } });
}

export async function importGalleryFromComfyUI() {
  return apiCall(importSpec, {});
}

export async function regenerateGalleryItem(id: string, randomizeSeed = false) {
  return apiCall(regenerateSpec, { params: { id }, body: { randomizeSeed } });
}
