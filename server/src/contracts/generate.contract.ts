// Zod schemas for /api/generate.

import { z } from 'zod';

export const AdvancedSettingValueSchema = z.object({
  proxyIndex: z.number().int().nonnegative(),
  value: z.unknown(),
});

export const GenerateBodySchema = z.object({
  templateName: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  advancedSettings: z.record(z.string(), AdvancedSettingValueSchema).optional(),
});

export const GenerateNodeErrorSchema = z.object({
  nodeId: z.string(),
  classType: z.string().optional(),
  message: z.string(),
  details: z.string().optional(),
});

export const GenerateResponseSchema = z.object({
  promptId: z.string(),
  statusUrl: z.string(),   // '/api/jobs/:promptId'
  streamUrl: z.string(),   // '/api/jobs/:promptId/events'
  number: z.number().int().nonnegative().optional(),
  node_errors: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
