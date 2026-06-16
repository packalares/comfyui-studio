// Zod schemas for the gallery domain.

import { z } from 'zod';

// ---- Shared sub-schemas ----

export const WorkflowDetailSchema = z.object({
  promptText:   z.string().nullable(),
  negativeText: z.string().nullable(),
  // v30 — output of every `__studio_enhanced_*` PreviewAny probe injected
  // downstream of `TextGenerate*` nodes, keyed by source compound node id.
  // The Details modal iterates the entries so each enhancer surfaces as
  // its own row. Distinct from `promptText` (the user-typed input).
  enhancedPrompts: z.record(z.string(), z.string()).nullable().optional(),
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
});
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;

export const GalleryListItemSchema = z.object({
  id:           z.string(),
  filename:     z.string(),
  subfolder:    z.string(),
  type:         z.string(),
  mediaType:    z.string(),
  url:          z.string(),
  promptId:     z.string(),
  templateName: z.string().nullable().optional(),
  sizeBytes:    z.number().nullable().optional(),
  createdAt:    z.number().optional(),
  jobDurationMs: z.number().nullable().optional(),
  favorite:     z.boolean().optional(),
});
export type GalleryListItem = z.infer<typeof GalleryListItemSchema>;

export const GalleryItemSchema = GalleryListItemSchema.extend({
  mediaDurationMs: z.number().nullable().optional(),
  mediaInfo:       z.record(z.string(), z.unknown()).nullable().optional(),
  workflowDetail:  WorkflowDetailSchema.nullable().optional(),
  // Wave 4 candidate: these are UI-hint fields that belong in the client, not the API row.
  prevId:          z.string().nullable().optional(),
  nextId:          z.string().nullable().optional(),
});
export type GalleryItem = z.infer<typeof GalleryItemSchema>;

// ---- Query schemas ----

export const GalleryListQuerySchema = z.object({
  page:      z.string().optional(),
  pageSize:  z.string().optional(),
  mediaType: z.string().optional(),
  sort:      z.enum(['newest', 'oldest']).optional(),
  favorite:  z.string().optional(),
});

export const GalleryByPromptIdsQuerySchema = z.object({
  ids: z.string().optional(),
});

export const GalleryNeighborQuerySchema = z.object({
  mediaType: z.string().optional(),
  sort:      z.enum(['newest', 'oldest']).optional(),
  favorite:  z.string().optional(),
});

export const GalleryIdParamsSchema = z.object({
  id: z.string().min(1),
});

// ---- Body schemas ----

export const GalleryFavoritePatchSchema = z.object({
  favorite: z.boolean(),
});

export const GalleryBulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const GalleryRegenerateBodySchema = z.object({
  randomizeSeed: z.boolean().optional(),
});

// ---- Response schemas ----

export const GalleryPageResponseSchema = z.object({
  items:    z.array(GalleryListItemSchema),
  page:     z.number().int(),
  pageSize: z.number().int(),
  total:    z.number().int(),
  hasMore:  z.boolean(),
});

export const GalleryByPromptIdsResponseSchema = z.object({
  items: z.array(GalleryListItemSchema),
});

export const GalleryDeleteResultSchema = z.object({
  deleted:     z.boolean(),
  id:          z.string(),
  fileDeleted: z.boolean().optional(),
});

export const GalleryBulkDeleteResponseSchema = z.object({
  deleted:   z.number().int(),
  requested: z.number().int(),
  results:   z.array(z.object({ id: z.string(), removed: z.boolean(), error: z.string().optional() })),
});

export const GalleryFavoriteResponseSchema = z.object({
  id:       z.string(),
  favorite: z.boolean(),
});

export const GalleryImportResponseSchema = z.object({
  imported: z.number().int().optional(),
  skipped:  z.number().int().optional(),
  errors:   z.number().int().optional(),
}).passthrough();

export const GalleryRegenerateResponseSchema = z.object({
  promptId: z.string().optional(),
}).passthrough();
