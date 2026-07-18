// Zod schemas for the capability-pack routes: GET /api/packs,
// POST /api/packs/:id/install, POST /api/packs/:id/uninstall,
// GET /api/packs/progress/:taskId.

import { z } from 'zod';

export const PackIdSchema = z.enum(['ace-step', 'ai-toolkit']);

export const PackSchema = z.object({
  id: PackIdSchema,
  label: z.string(),
  description: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  installedAt: z.number().nullable(),
});

export const PackListResponseSchema = z.object({
  items: z.array(PackSchema),
});

export const PackParamsSchema = z.object({
  id: z.string().min(1),
});

export const PackTaskStartedSchema = z.object({
  taskId: z.string(),
});

export const PackTaskParamsSchema = z.object({
  taskId: z.string().min(1),
});

export const PackTaskProgressSchema = z.object({
  taskId: z.string(),
  packId: z.string(),
  type: z.enum(['install', 'uninstall']),
  progress: z.number(),
  completed: z.boolean(),
  message: z.string().optional(),
  logs: z.array(z.string()),
});
