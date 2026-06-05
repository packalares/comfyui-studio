// Zod schemas for the plugins domain.

import { z } from 'zod';

// ---- Shared sub-schemas ----

const VersionInfoSchema = z.object({
  id:                             z.string(),
  version:                        z.string(),
  changelog:                      z.string().optional(),
  createdAt:                      z.string(),
  deprecated:                     z.boolean(),
  downloadUrl:                    z.string().optional(),
  node_id:                        z.string(),
  status:                         z.string(),
  dependencies:                   z.array(z.string()).optional(),
  supported_accelerators:         z.array(z.string()).nullable().optional(),
  supported_comfyui_frontend_version: z.string().optional(),
  supported_comfyui_version:      z.string().optional(),
  supported_os:                   z.array(z.string()).nullable().optional(),
});

export const PluginSchema = z.object({
  id:              z.string(),
  name:            z.string(),
  description:     z.string(),
  author:          z.string(),
  repository:      z.string(),
  version:         z.string(),
  latest_version:  VersionInfoSchema.nullable().optional(),
  versions:        z.array(VersionInfoSchema).optional(),
  status:          z.string(),
  status_detail:   z.string().optional(),
  rating:          z.number(),
  downloads:       z.number(),
  github_stars:    z.number(),
  icon:            z.string().optional(),
  banner_url:      z.string().optional(),
  category:        z.string().optional(),
  license:         z.string().optional(),
  tags:            z.array(z.string()).optional(),
  dependencies:    z.array(z.string()).optional(),
  requirements:    z.array(z.string()).optional(),
  supported_accelerators:          z.array(z.string()).nullable().optional(),
  supported_comfyui_frontend_version: z.string().optional(),
  supported_comfyui_version:       z.string().optional(),
  supported_os:    z.array(z.string()).nullable().optional(),
  created_at:      z.string(),
  lastModified:    z.string().optional(),
  installed:       z.boolean(),
  installedOn:     z.string().optional(),
  disabled:        z.boolean(),
  hasInstallScript:     z.boolean().optional(),
  hasRequirementsFile:  z.boolean().optional(),
  size:            z.number().optional(),
}).passthrough();
export type PluginRow = z.infer<typeof PluginSchema>;

export const PluginOpStatusSchema = z.enum(['running', 'success', 'failed']);

export const PluginTaskProgressSchema = z.object({
  progress:    z.number(),
  completed:   z.boolean(),
  pluginId:    z.string(),
  type:        z.enum(['install', 'uninstall', 'disable', 'enable', 'switch-version']),
  message:     z.string().optional(),
  githubProxy: z.string().optional(),
  logs:        z.array(z.string()).optional(),
});

export const PluginHistoryItemSchema = z.object({
  id:          z.string(),
  pluginId:    z.string(),
  pluginName:  z.string().optional(),
  type:        z.enum(['install', 'uninstall', 'disable', 'enable', 'switch-version']),
  typeText:    z.string().optional(),
  startTime:   z.number(),
  endTime:     z.number().optional(),
  status:      PluginOpStatusSchema,
  statusText:  z.string().optional(),
  logs:        z.array(z.string()),
  result:      z.string().optional(),
  githubProxy: z.string().optional(),
});

// ---- Query schemas ----

export const PluginListQuerySchema = z.object({
  page:     z.string().optional(),
  pageSize: z.string().optional(),
  q:        z.string().optional(),
  filter:   z.string().optional(),
  force:    z.string().optional(),
});

export const PluginTaskParamsSchema = z.object({
  taskId: z.string().min(1),
});

export const PluginHistoryQuerySchema = z.object({
  page:     z.string().optional(),
  pageSize: z.string().optional(),
  limit:    z.string().optional(),
});

// ---- Body schemas ----

export const PluginInstallBodySchema = z.object({
  pluginId:     z.string().min(1),
  githubProxy:  z.string().optional(),
});

export const PluginIdBodySchema = z.object({
  pluginId: z.string().min(1),
});

export const PluginCustomInstallBodySchema = z.object({
  githubUrl: z.string().min(1),
  branch:    z.string().optional(),
});

export const PluginSwitchVersionBodySchema = z.object({
  pluginId:      z.string().min(1),
  targetVersion: z.object({ id: z.string().optional(), version: z.string().optional() }),
  githubProxy:   z.string().optional(),
});

export const PluginHistoryDeleteBodySchema = z.object({
  id: z.string().min(1),
});

// ---- Response schemas ----

export const PluginListResponseSchema = z.object({
  items:    z.array(PluginSchema),
  page:     z.number().int(),
  pageSize: z.number().int(),
  total:    z.number().int(),
  hasMore:  z.boolean(),
});

export const PluginTaskStartedSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  taskId:  z.string(),
});

export const PluginCustomInstallStartedSchema = PluginTaskStartedSchema.extend({
  pluginId: z.string(),
});

export const PluginSwitchVersionStartedSchema = PluginTaskStartedSchema;

export const PluginRefreshResponseSchema = z.object({
  success:        z.boolean(),
  catalogUpdated: z.boolean(),
  upstreamError:  z.string().optional(),
  pluginsCount:   z.number().int(),
  installedCount: z.number().int(),
});

export const PluginLogsResponseSchema = z.object({
  success: z.boolean(),
  logs:    z.array(z.string()),
});

export const PluginHistoryResponseSchema = z.object({
  success: z.boolean(),
  history: z.array(PluginHistoryItemSchema).optional(),
  items:   z.array(PluginHistoryItemSchema).optional(),
  page:    z.number().int().optional(),
  pageSize: z.number().int().optional(),
  total:   z.number().int().optional(),
  hasMore: z.boolean().optional(),
});

export const PluginHistoryClearResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const PluginHistoryDeleteResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});
