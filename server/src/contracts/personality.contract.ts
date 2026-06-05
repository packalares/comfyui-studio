// Zod schemas for /api/personality routes.

import { z } from 'zod';

export const LibraryTypeSchema = z.enum(['soul', 'skill', 'command']);
export type LibraryType = z.infer<typeof LibraryTypeSchema>;

export const PersonalityTypeParamSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
});

export const WriteBodySchema = z.object({ body: z.string() });

export const EditActionBodySchema = z.object({ action: z.literal('accept') });

export const ItemDetailSchema = z.object({
  name: z.string(),
  body: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  scripts: z.array(z.string()).optional(),
  argumentHint: z.string().optional(),
});

export const MemoryBodySchema = z.object({ body: z.string() });
export const MemoryResponseSchema = z.object({ body: z.string() });
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export const EditAcceptResponseSchema = z.object({ ok: z.boolean(), soulName: z.string().optional() });
