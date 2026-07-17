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

/**
 * Models search query. `q` is now optional — the UI's "browse by Type=LORA"
 * use case sends an empty query alongside one or more filters. The route
 * handler rejects the all-empty case (`Missing search query`) so we don't
 * forward a useless request to CivitAI.
 *
 * `types`, `baseModels` arrive as either bare arrays (`?types=LORA&types=VAE`)
 * or bracketed arrays (`?types[]=LORA`). Express's default query parser
 * surfaces both as `string[]`; we coerce string-or-array to `string[]`.
 */
const stringOrStringArray = z.union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.length === 0 ? [] : [v]));

export const CivitaiSearchQuerySchema = CivitaiPageQuerySchema.extend({
  q:          z.string().optional(),
  types:      stringOrStringArray.optional(),
  baseModels: stringOrStringArray.optional(),
  nsfw:       z.string().optional(),
  period:     z.enum(['AllTime', 'Year', 'Month', 'Week', 'Day']).optional(),
  sort:       z.enum(['Highest Rated', 'Most Downloaded', 'Newest']).optional(),
}).passthrough();
// Express's qs parser surfaces `types[]=A&types[]=B` under the literal key
// `types[]`. `.passthrough()` keeps the bracketed alias visible so the route
// handler can pick whichever form arrived.

export const CivitaiByUrlQuerySchema = CivitaiPageQuerySchema.extend({
  url: z.string().optional(),
});

export const CivitaiModelParamsSchema = z.object({
  id: z.string().min(1),
});

export const CivitaiVersionParamsSchema = z.object({
  versionId: z.string().min(1),
});

// ---- Facets endpoint ----

export const CivitaiFacetsResponseSchema = z.object({
  types:      z.array(z.string()),
  baseModels: z.array(z.string()),
  periods:    z.array(z.string()),
  sorts:      z.array(z.string()),
});
export type CivitaiFacetsResponse = z.infer<typeof CivitaiFacetsResponseSchema>;

export const facetsRoute = {
  method: 'GET' as const,
  path: '/civitai/models/facets',
  response: CivitaiFacetsResponseSchema,
  summary: 'CivitAI search vocabulary (types/baseModels/periods/sorts)',
};
