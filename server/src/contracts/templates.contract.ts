// Zod schemas for /api/templates routes.

import { z } from 'zod';

export const TemplateParamsSchema = z.object({ name: z.string().min(1) });

export const TemplatesListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  q: z.string().optional(),
  category: z.string().optional(),
  tags: z.string().optional(),
  source: z.enum(['all', 'open', 'api', 'user', 'favorites']).optional(),
  ready: z.enum(['all', 'yes', 'no']).optional(),
});

export const FavoritePatchSchema = z.object({ favorite: z.boolean() });

export const TemplateFavoriteResponseSchema = z.object({
  name: z.string(),
  favorite: z.boolean(),
});
