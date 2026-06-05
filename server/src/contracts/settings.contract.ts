// Zod schemas for /api/settings routes.

import { z } from 'zod';

export const SecretNameSchema = z.enum([
  'apiKeyComfyOrg',
  'hfToken',
  'civitaiToken',
  'githubToken',
  'pexelsApiKey',
  'studioMcpToken',
]);
export type SecretName = z.infer<typeof SecretNameSchema>;

// z.record with enum key in Zod v4 doesn't support .partial(); use z.object instead
export const SecretPatchSchema = z.object({
  apiKeyComfyOrg: z.string().optional(),
  hfToken: z.string().optional(),
  civitaiToken: z.string().optional(),
  githubToken: z.string().optional(),
  pexelsApiKey: z.string().optional(),
  studioMcpToken: z.string().optional(),
}).partial();

export const ChatAdvancedPatchSchema = z.object({
  highWaterPercent: z.number().finite().optional(),
  maxToolSteps: z.number().finite().optional(),
  loadingHintMs: z.number().finite().optional(),
  keepRecent: z.number().finite().optional(),
  titleTimeoutMs: z.number().finite().optional(),
  summaryTimeoutMs: z.number().finite().optional(),
  smartSuggestions: z.boolean().optional(),
}).partial();

export const ChatPatchSchema = z.object({
  ollamaUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  keepAlive: z.string().optional(),
  defaultContextStrategy: z.enum(['sliding', 'auto']).optional(),
  defaultThinkMode: z.enum(['on', 'off', 'auto']).optional(),
  advanced: ChatAdvancedPatchSchema.optional(),
}).partial();

export const ToolsPatchSchema = z.object({
  searxngUrl: z.string().optional(),
  defaultImageTemplate: z.string().optional(),
  enabledMcpTools: z.record(z.string(), z.boolean()).optional(),
}).partial();

export const ProbeBodySchema = z.object({
  type: z.enum(['ollama', 'searxng']),
  url: z.string().min(1),
});

export const ProbeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), count: z.number().int().nonnegative().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const SettingsKeySchema = z.enum(['secret', 'chat', 'tools']);
export type SettingsKey = z.infer<typeof SettingsKeySchema>;

export const DeleteSecretQuerySchema = z.object({ name: SecretNameSchema });
