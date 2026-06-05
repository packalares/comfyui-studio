// Typed wrappers for plugin routes.

import { z } from 'zod';
import { apiCall, apiCallPaginated } from './client.js';
import type { PluginTaskProgress, PluginHistoryEntry } from '../types/index.js';

// ---- Inline schemas ----

const PluginSchema = z.object({
  id:          z.string(),
  name:        z.string(),
  description: z.string(),
  author:      z.string(),
  repository:  z.string(),
  version:     z.string(),
  status:      z.string(),
  rating:      z.number(),
  downloads:   z.number(),
  github_stars: z.number(),
  installed:   z.boolean(),
  disabled:    z.boolean(),
  created_at:  z.string(),
}).passthrough();

const PluginTaskProgressSchema = z.object({
  progress:  z.number(),
  completed: z.boolean(),
  pluginId:  z.string(),
  type:      z.enum(['install', 'uninstall', 'disable', 'enable', 'switch-version']),
  message:   z.string().optional(),
  logs:      z.array(z.string()).optional(),
}).passthrough();

const PluginHistoryItemSchema = z.object({
  id:        z.string(),
  pluginId:  z.string(),
  type:      z.enum(['install', 'uninstall', 'disable', 'enable', 'switch-version']),
  startTime: z.number(),
  status:    z.enum(['running', 'success', 'failed']),
  logs:      z.array(z.string()),
}).passthrough();

const PluginListResponseSchema = z.object({
  items:    z.array(PluginSchema),
  page:     z.number(),
  pageSize: z.number(),
  total:    z.number(),
  hasMore:  z.boolean(),
});

const PluginTaskStartedSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  taskId:  z.string(),
});

const PluginCustomInstallStartedSchema = PluginTaskStartedSchema.extend({
  pluginId: z.string(),
});

const PluginRefreshResponseSchema = z.object({
  success:        z.boolean(),
  catalogUpdated: z.boolean(),
  upstreamError:  z.string().optional(),
  pluginsCount:   z.number(),
  installedCount: z.number(),
});

const PluginLogsResponseSchema = z.object({
  success: z.boolean(),
  logs:    z.array(z.string()),
});

const PluginHistoryResponseSchema = z.object({
  success: z.boolean(),
  history: z.array(PluginHistoryItemSchema).optional(),
  items:   z.array(PluginHistoryItemSchema).optional(),
  page:    z.number().optional(),
  pageSize: z.number().optional(),
  total:   z.number().optional(),
  hasMore: z.boolean().optional(),
});

const PluginSimpleResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

// ---- Route specs ----

const listSpec = {
  method: 'GET' as const,
  path: '/plugins',
  query: z.object({
    page: z.string().optional(), pageSize: z.string().optional(),
    q: z.string().optional(), filter: z.string().optional(), force: z.string().optional(),
  }),
  response: PluginListResponseSchema,
};

const installSpec = {
  method: 'POST' as const,
  path: '/plugins/install',
  body: z.object({ pluginId: z.string(), githubProxy: z.string().optional() }),
  response: PluginTaskStartedSchema,
};

const uninstallSpec = {
  method: 'POST' as const,
  path: '/plugins/uninstall',
  body: z.object({ pluginId: z.string() }),
  response: PluginTaskStartedSchema,
};

const disableSpec = {
  method: 'POST' as const,
  path: '/plugins/disable',
  body: z.object({ pluginId: z.string() }),
  response: PluginTaskStartedSchema,
};

const enableSpec = {
  method: 'POST' as const,
  path: '/plugins/enable',
  body: z.object({ pluginId: z.string() }),
  response: PluginTaskStartedSchema,
};

const progressSpec = {
  method: 'GET' as const,
  path: '/plugins/progress/:taskId',
  params: z.object({ taskId: z.string() }),
  response: PluginTaskProgressSchema,
};

const refreshSpec = {
  method: 'GET' as const,
  path: '/plugins/refresh',
  response: PluginRefreshResponseSchema,
};

const customInstallSpec = {
  method: 'POST' as const,
  path: '/plugins/install-custom',
  body: z.object({ githubUrl: z.string(), branch: z.string().optional() }),
  response: PluginCustomInstallStartedSchema,
};

const switchVersionSpec = {
  method: 'POST' as const,
  path: '/plugins/switch-version',
  body: z.object({
    pluginId:      z.string(),
    targetVersion: z.object({ id: z.string().optional(), version: z.string().optional() }),
    githubProxy:   z.string().optional(),
  }),
  response: PluginTaskStartedSchema,
};

const historySpec = {
  method: 'GET' as const,
  path: '/plugins/history',
  query: z.object({ page: z.string().optional(), pageSize: z.string().optional(), limit: z.string().optional() }),
  response: PluginHistoryResponseSchema,
};

const logsSpec = {
  method: 'GET' as const,
  path: '/plugins/logs/:taskId',
  params: z.object({ taskId: z.string() }),
  response: PluginLogsResponseSchema,
};

const historyClearSpec = {
  method: 'POST' as const,
  path: '/plugins/history/clear',
  response: PluginSimpleResponseSchema,
};

const historyDeleteSpec = {
  method: 'POST' as const,
  path: '/plugins/history/delete',
  body: z.object({ id: z.string() }),
  response: PluginSimpleResponseSchema,
};

// ---- Public API ----

export async function getPluginsPaged(
  page: number,
  pageSize: number,
  opts: { q?: string; filter?: string } = {},
) {
  const query: Record<string, string> = { page: String(page), pageSize: String(pageSize) };
  if (opts.q) query.q = opts.q;
  if (opts.filter) query.filter = opts.filter;
  return apiCall(listSpec, { query });
}

export async function installPlugin(pluginId: string, githubProxy?: string) {
  return apiCall(installSpec, { body: { pluginId, githubProxy } });
}

export async function uninstallPlugin(pluginId: string) {
  return apiCall(uninstallSpec, { body: { pluginId } });
}

export async function disablePlugin(pluginId: string) {
  return apiCall(disableSpec, { body: { pluginId } });
}

export async function enablePlugin(pluginId: string) {
  return apiCall(enableSpec, { body: { pluginId } });
}

export async function getPluginProgress(taskId: string): Promise<PluginTaskProgress> {
  return apiCall(progressSpec, { params: { taskId } }) as Promise<PluginTaskProgress>;
}

export async function refreshPlugins() {
  return apiCall(refreshSpec, {});
}

export async function customInstallPlugin(githubUrl: string, branch?: string) {
  return apiCall(customInstallSpec, { body: { githubUrl, branch } });
}

export async function switchPluginVersion(
  pluginId: string,
  targetVersion: { id?: string; version?: string },
  githubProxy?: string,
) {
  return apiCall(switchVersionSpec, { body: { pluginId, targetVersion, githubProxy } });
}

export async function getPluginHistory(limit = 100): Promise<PluginHistoryEntry[]> {
  const res = await apiCall(historySpec, { query: { limit: String(limit) } });
  return (res.history ?? []) as PluginHistoryEntry[];
}

export async function getPluginHistoryPaged(page: number, pageSize: number) {
  return apiCall(historySpec, { query: { page: String(page), pageSize: String(pageSize) } });
}

export async function getPluginLogs(taskId: string) {
  return apiCall(logsSpec, { params: { taskId } });
}

export async function clearPluginHistory() {
  return apiCall(historyClearSpec, {});
}

export async function deletePluginHistoryItem(id: string) {
  return apiCall(historyDeleteSpec, { body: { id } });
}
