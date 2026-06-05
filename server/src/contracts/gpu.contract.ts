// Zod schemas for GPU scheduler routes: GET /api/gpu and DELETE /api/gpu/queue/:id.

import { z } from 'zod';

export const ActiveJobSchema = z.object({
  jobId: z.string(),
  taskType: z.string(),
  tenant: z.enum(['ollama', 'comfy', 'none']),
  priority: z.number(),
  startedAt: z.number(),
});

export const QueueEntrySchema = z.object({
  jobId: z.string(),
  taskType: z.string(),
  tenant: z.enum(['ollama', 'comfy', 'none']),
  priority: z.number(),
  enqueuedAt: z.number(),
});

export const SchedulerSnapshotSchema = z.object({
  residency: z.enum(['ollama', 'comfy', 'none']),
  active: ActiveJobSchema.nullable(),
  queue: z.array(QueueEntrySchema),
});

export const CancelJobParamsSchema = z.object({
  id: z.string().min(1),
});

export const CancelJobOutputSchema = z.object({
  cancelled: z.boolean(),
  jobId: z.string(),
});
