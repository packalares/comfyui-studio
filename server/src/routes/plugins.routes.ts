// Plugin routes — list, install, uninstall, disable, enable, refresh,
// custom install, switch version, progress poll, history, logs.

import { Router } from 'express';
import * as plugins from '../services/plugins/index.js';
import { fetchUpstreamCatalog } from '../services/plugins/upstreamFetch.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { parsePageQuery, paginate, splitPaginated } from '../lib/pagination.js';
import {
  PluginSchema,
  PluginListResponseSchema,
  PluginTaskProgressSchema,
  PluginHistoryItemSchema,
  PluginTaskStartedSchema,
  PluginCustomInstallStartedSchema,
  PluginSwitchVersionStartedSchema,
  PluginRefreshResponseSchema,
  PluginLogsResponseSchema,
  PluginHistoryResponseSchema,
  PluginHistoryClearResponseSchema,
  PluginHistoryDeleteResponseSchema,
  PluginListQuerySchema,
  PluginTaskParamsSchema,
  PluginInstallBodySchema,
  PluginIdBodySchema,
  PluginCustomInstallBodySchema,
  PluginSwitchVersionBodySchema,
  PluginHistoryQuerySchema,
  PluginHistoryDeleteBodySchema,
} from '../contracts/plugins.contract.js';
import { z } from 'zod';

// 10 writes/min/IP.
const writeLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// ---- Routes ----

const listRoute = defineRoute({
  method: 'GET',
  path: '/plugins',
  query: PluginListQuerySchema,
  response: PluginListResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['plugins'],
  summary: 'List plugins (paginated, filterable)',
}, async (ctx) => {
  const forceRefresh = ctx.query.force === 'true';
  if (forceRefresh) plugins.cache.refreshInstalledPlugins();
  const all = plugins.cache.getAllPlugins(forceRefresh);
  const pq = parsePageQuery(ctx.req, { defaultPageSize: 50, maxPageSize: 200 });

  if (!pq.isPaginated) {
    // Back-compat: return all items as a page-1 envelope.
    return ctx.ok({ items: all as unknown as z.infer<typeof PluginSchema>[], page: 1, pageSize: all.length || 50, total: all.length, hasMore: false });
  }

  const q = typeof ctx.query.q === 'string' ? ctx.query.q.toLowerCase().trim() : '';
  const filter = ctx.query.filter ?? 'all';
  let rows = all;
  if (filter === 'installed') rows = rows.filter(p => p.installed);
  else if (filter === 'available') rows = rows.filter(p => !p.installed);
  if (q) {
    rows = rows.filter(p =>
      (p.name ?? '').toLowerCase().includes(q) ||
      (p.id ?? '').toLowerCase().includes(q) ||
      (p.description ?? '').toLowerCase().includes(q) ||
      (p.author ?? '').toLowerCase().includes(q) ||
      (Array.isArray(p.tags) && p.tags.some(t => (t ?? '').toLowerCase().includes(q))),
    );
  }
  rows = [...rows].sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
  const env = paginate(rows, pq.page, pq.pageSize);
  const { meta } = splitPaginated(env);
  return ctx.ok({ items: env.items as unknown as z.infer<typeof PluginSchema>[], ...meta } as z.infer<typeof PluginListResponseSchema>, meta);
});

const installRoute = defineRoute({
  method: 'POST',
  path: '/plugins/install',
  body: PluginInstallBodySchema,
  response: PluginTaskStartedSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Install a plugin by catalog id',
}, async (ctx) => {
  const { pluginId, githubProxy } = ctx.body;
  const list = plugins.cache.getAllPlugins(false);
  const info = list.find(p => p.id === pluginId);
  if (!info) throw new NotFoundError(`Plugin not found: ${pluginId}`);
  const taskId = await plugins.install.installPlugin(pluginId, info, githubProxy);
  return ctx.ok({ success: true, message: 'Installation started', taskId });
});

const uninstallRoute = defineRoute({
  method: 'POST',
  path: '/plugins/uninstall',
  body: PluginIdBodySchema,
  response: PluginTaskStartedSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Uninstall a plugin',
}, async (ctx) => {
  const taskId = await plugins.uninstall.uninstallPlugin(ctx.body.pluginId);
  return ctx.ok({ success: true, message: 'Uninstall started', taskId });
});

const disableRoute = defineRoute({
  method: 'POST',
  path: '/plugins/disable',
  body: PluginIdBodySchema,
  response: PluginTaskStartedSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Disable a plugin',
}, async (ctx) => {
  const taskId = await plugins.uninstall.disablePlugin(ctx.body.pluginId);
  return ctx.ok({ success: true, message: 'Disable started', taskId });
});

const enableRoute = defineRoute({
  method: 'POST',
  path: '/plugins/enable',
  body: PluginIdBodySchema,
  response: PluginTaskStartedSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Enable a plugin',
}, async (ctx) => {
  const taskId = await plugins.uninstall.enablePlugin(ctx.body.pluginId);
  return ctx.ok({ success: true, message: 'Enable started', taskId });
});

const progressRoute = defineRoute({
  method: 'GET',
  path: '/plugins/progress/:taskId',
  params: PluginTaskParamsSchema,
  response: PluginTaskProgressSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['plugins'],
  summary: 'Poll install/uninstall progress',
}, (ctx) => {
  const p = plugins.progress.getTaskProgress(ctx.params.taskId);
  if (!p) throw new NotFoundError('Task not found');
  return ctx.ok(p);
});

const refreshRoute = defineRoute({
  method: 'GET',
  path: '/plugins/refresh',
  response: PluginRefreshResponseSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Pull fresh catalog from upstream and re-scan custom_nodes',
}, async (ctx) => {
  let catalogUpdated = false;
  let upstreamError: string | undefined;
  try {
    const nodes = await fetchUpstreamCatalog();
    plugins.cache.writeMirror(nodes);
    catalogUpdated = true;
  } catch (err) {
    upstreamError = err instanceof Error ? err.message : String(err);
    try { plugins.cache.reseedFromMirror(); } catch { /* ignore */ }
  }
  const list = plugins.cache.refreshInstalledPlugins();
  return ctx.ok({
    success: true,
    catalogUpdated,
    upstreamError,
    pluginsCount: plugins.cache.getAllPlugins(false).length,
    installedCount: list.length,
  });
});

const customInstallRoute = defineRoute({
  method: 'POST',
  path: '/plugins/install-custom',
  body: PluginCustomInstallBodySchema,
  response: PluginCustomInstallStartedSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Git-clone an arbitrary whitelisted GitHub URL',
}, async (ctx) => {
  const { taskId, pluginId } = await plugins.install.installCustomPlugin(
    ctx.body.githubUrl, ctx.body.branch, undefined,
  );
  return ctx.ok({ success: true, message: 'Custom install started', taskId, pluginId });
});

const switchVersionRoute = defineRoute({
  method: 'POST',
  path: '/plugins/switch-version',
  body: PluginSwitchVersionBodySchema,
  response: PluginSwitchVersionStartedSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Checkout a specific plugin version',
}, (ctx) => {
  const { pluginId, targetVersion, githubProxy } = ctx.body;
  const list = plugins.cache.getAllPlugins(false);
  const pluginInfo = list.find(p => p.id === pluginId);
  if (!pluginInfo) throw new NotFoundError(`Plugin not found: ${pluginId}`);
  const repositoryUrl = pluginInfo.repository || pluginInfo.github || '';
  if (!repositoryUrl) throw new ValidationError('Plugin has no repository URL');
  const proxy = (typeof githubProxy === 'string' && githubProxy) ? githubProxy : '';
  const taskId = plugins.switchVersion.switchPluginVersion(pluginId, repositoryUrl, targetVersion, proxy);
  return ctx.ok({ success: true, message: `Switching to ${targetVersion.version ?? 'target'}`, taskId });
});

const historyRoute = defineRoute({
  method: 'GET',
  path: '/plugins/history',
  query: PluginHistoryQuerySchema,
  response: PluginHistoryResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['plugins'],
  summary: 'Recent install/uninstall operations',
}, (ctx) => {
  const pq = parsePageQuery(ctx.req, { defaultPageSize: 20, maxPageSize: 100 });
  if (!pq.isPaginated) {
    const limit = ctx.query.limit ? parseInt(ctx.query.limit, 10) : 100;
    return ctx.ok({ success: true, history: plugins.history.getHistory(limit) });
  }
  const all = plugins.history.getHistory(100);
  const env = paginate(all, pq.page, pq.pageSize);
  const { meta } = splitPaginated(env);
  return ctx.ok({ success: true, items: env.items, ...meta }, meta);
});

const logsRoute = defineRoute({
  method: 'GET',
  path: '/plugins/logs/:taskId',
  params: PluginTaskParamsSchema,
  response: PluginLogsResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['plugins'],
  summary: 'Fetch persisted logs for an operation',
}, (ctx) => {
  const logs = plugins.history.getLogs(ctx.params.taskId);
  if (!logs) throw new NotFoundError('Task not found');
  return ctx.ok({ success: true, logs });
});

const historyClearRoute = defineRoute({
  method: 'POST',
  path: '/plugins/history/clear',
  response: PluginHistoryClearResponseSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Clear plugin operation history',
}, (ctx) => {
  plugins.history.clearHistory();
  return ctx.ok({ success: true, message: 'History cleared' });
});

const historyDeleteRoute = defineRoute({
  method: 'POST',
  path: '/plugins/history/delete',
  body: PluginHistoryDeleteBodySchema,
  response: PluginHistoryDeleteResponseSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['plugins'],
  summary: 'Delete a single history entry',
}, (ctx) => {
  const removed = plugins.history.deleteHistoryItem(ctx.body.id);
  if (!removed) throw new NotFoundError('History item not found');
  return ctx.ok({ success: true, message: `History item deleted: ${removed.pluginId}` });
});

// ---- Mount (write endpoints get the rate-limiter injected via Express) ----
// `defineRoute` doesn't compose middleware — for rate-limiting we wrap the
// handler so the limiter fires before defineRoute's validation.
const router = Router();

// Read-only (no rate-limit).
[listRoute, progressRoute, refreshRoute, historyRoute, logsRoute].forEach(r => r.register(router));

// Writes — inject limiter before the defineRoute handler.
const writeLimited = (r: ReturnType<typeof defineRoute>) => {
  const method = r.spec.method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete' | 'get';
  router[method](r.spec.path, writeLimiter, (req, res, next) => {
    // Delegate to defineRoute's own handler via a throwaway mini-router.
    const mini = Router();
    r.register(mini);
    mini(req, res, next);
  });
};

[
  installRoute,
  uninstallRoute,
  disableRoute,
  enableRoute,
  customInstallRoute,
  switchVersionRoute,
  historyClearRoute,
  historyDeleteRoute,
].forEach(writeLimited);

export default router;
