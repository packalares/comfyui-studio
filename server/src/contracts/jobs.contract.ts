// Zod schemas for the per-job status and SSE event stream contract.

import { z } from 'zod';
import { GalleryListItemSchema } from './gallery.contract.js';

// Slim reference used in the done result — subset of GalleryListItem.
export const GalleryItemRefSchema = GalleryListItemSchema.pick({
  id: true,
  filename: true,
  mediaType: true,
  url: true,
  promptId: true,
});
export type GalleryItemRef = z.infer<typeof GalleryItemRefSchema>;

export const JobProgressSchema = z.object({
  node: z.string(),
  step: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

export const JobErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const JobStatusSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled']),
  progress: JobProgressSchema.optional(),
  result: z.object({ items: z.array(GalleryItemRefSchema) }).optional(),
  error: JobErrorSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type JobStatus = z.infer<typeof JobStatusSchema>;

// SSE event payload schemas — one per event name on the /api/jobs/:id/events stream.

export const JobEventStatusSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled']),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const JobEventProgressSchema = z.object({
  node: z.string(),
  step: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const JobEventDoneSchema = z.object({
  status: z.literal('success'),
  items: z.array(GalleryItemRefSchema),
});

export const JobEventErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
