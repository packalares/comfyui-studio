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

// ComfyUI-side state mirror, derived from bridge WS messages. Surfaced so
// the sidebar can show comfy-direct work that Studio's scheduler didn't
// submit (and therefore doesn't track in its own queue).
export const ComfyBridgeStateSchema = z.object({
  connected: z.boolean(),
  queueRemaining: z.number().nullable(),
  executing: z.array(z.string()),
  studioTracked: z.number(),
});

export const SchedulerSnapshotSchema = z.object({
  residency: z.enum(['ollama', 'comfy', 'none']),
  active: ActiveJobSchema.nullable(),
  queue: z.array(QueueEntrySchema),
  comfy: ComfyBridgeStateSchema,
});

export const CancelJobParamsSchema = z.object({
  id: z.string().min(1),
});

export const CancelJobOutputSchema = z.object({
  cancelled: z.boolean(),
  jobId: z.string(),
});

export const ForceReleaseActiveOutputSchema = z.object({
  released: z.boolean(),
});
