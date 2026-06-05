// Zod schemas for the civitai passthrough domain.

import { z } from 'zod';

// ---- Shared sub-schemas ----

// Intentionally loose — we're a thin proxy; only fields the UI renders are typed.
export const CivitaiModelSummarySchema = z.object({
  id:    z.number(),
  name:  z.string(),
}).passthrough();

export const CivitaiModelDetailSchema = z.object({
  id:   z.number().optional(),
  name: z.string().optional(),
}).passthrough();

export const CivitaiDownloadInfoSchema = z.object({
  id:      z.number().optional(),
  modelId: z.number().optional(),
  name:    z.string().optional(),
}).passthrough();

// Page envelope shape returned by all list endpoints.
export const CivitaiPageResponseSchema = z.object({
  items:      z.array(CivitaiModelSummarySchema),
  page:       z.number().int(),
  pageSize:   z.number().int(),
  total:      z.number().int(),
  hasMore:    z.boolean(),
  nextCursor: z.string().optional(),
});
export type CivitaiPageResponse = z.infer<typeof CivitaiPageResponseSchema>;

// ---- Query schemas ----

export const CivitaiPageQuerySchema = z.object({
  limit:    z.string().optional(),
  page:     z.string().optional(),
  cursor:   z.string().optional(),
  pageSize: z.string().optional(),
});

export const CivitaiSearchQuerySchema = CivitaiPageQuerySchema.extend({
  q: z.string().min(1),
});

export const CivitaiByUrlQuerySchema = CivitaiPageQuerySchema.extend({
  url: z.string().optional(),
});

export const CivitaiModelParamsSchema = z.object({
  id: z.string().min(1),
});

export const CivitaiVersionParamsSchema = z.object({
  versionId: z.string().min(1),
});
