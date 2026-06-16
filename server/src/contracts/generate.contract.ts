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
  /**
   * Optional Easy-mode hint. When provided, the submit handler looks up
   * `template.studioModes[mode]` in the TemplateData metadata: mutes the listed
   * inactive nodes (sets node.mode = 4) and writes the switch widget
   * value if present. Templates without a `modes` block ignore this.
   */
  mode: z.string().min(1).optional(),
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
