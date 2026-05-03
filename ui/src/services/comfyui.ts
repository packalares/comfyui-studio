import type {
  Template,
  SystemStats,
  QueueStatus,
  GalleryItem,
  CatalogModel,
  DependencyCheck,
  AdvancedSetting,
  EnumeratedWidget,
  FormInput,
  Plugin,
  PluginTaskProgress,
  PluginHistoryEntry,
  PythonPackage,
  PluginDependencyReport,
  CivitaiModelSummary,
  CivitaiDownloadInfo,
  StagedImportManifest,
  CivitaiStagedResponse,
  CivitaiDirectResponse,
  InstallMissingPluginsResult,
} from '../types';

const BASE = '/api';

/** Standard paginated-list response envelope returned by `?page=N` endpoints. */
export interface PageEnvelope<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  /**
   * Optional opaque continuation cursor. Only populated by cursor-based
   * upstreams (CivitAI search). Plain page-based endpoints omit it.
   */
  nextCursor?: string;
}

function buildPagedQuery(params: { page: number; pageSize: number; extra?: Record<string, string> }): string {
  const qs = new URLSearchParams();
  qs.set('page', String(params.page));
  qs.set('pageSize', String(params.pageSize));
  if (params.extra) {
    for (const [k, v] of Object.entries(params.extra)) qs.set(k, v);
  }
  return qs.toString();
}

/**
 * Typed error thrown by `fetchJson` when the API returns non-2xx. Carries
 * the parsed JSON body when the server provided one — callers that want to
 * surface structured error payloads (e.g. /generate's node_errors) read
 * `data` directly instead of parsing the Error message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;
  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let data: unknown = null;
    let msg = `${res.status} ${res.statusText}`;
    try {
      data = await res.json();
      if (data && typeof data === 'object' && 'error' in data) {
        const e = (data as { error?: unknown }).error;
        if (typeof e === 'string' && e.length > 0) msg = e;
      }
    } catch { /* non-JSON body */ }
    throw new ApiError(res.status, msg, data);
  }
  return res.json();
}

/** Fetch a response body as text (used for the pip-source GET which returns a plain string). */
async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(`${BASE}${url}`, init);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * Build a civitai pagination query string. CivitAI uses `page=` for plain
 * sort endpoints and `cursor=` when `query=` is active (its search path
 * refuses page-based pagination). Callers thread `cursor` from the previous
 * envelope's `nextCursor` when doing search.
 */
function buildCivitaiPageQuery(opts: {
  page?: number; pageSize?: number; cursor?: string; query?: string;
}): string {
  const params = new URLSearchParams();
  if (opts.pageSize !== undefined) params.set('pageSize', String(opts.pageSize));
  if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
  else if (opts.page !== undefined) params.set('page', String(opts.page));
  if (opts.query !== undefined && opts.query.length > 0) params.set('q', opts.query);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export type SecretName =
  | 'apiKeyComfyOrg'
  | 'hfToken'
  | 'civitaiToken'
  | 'githubToken'
  | 'pexelsApiKey';

export const api = {
  // Unified secret store. Writes go to a single endpoint that accepts a
  // name→value map (one or many keys per call — UI sends only dirty fields).
  // Clears are per-name. Status flags still ride on `GET /system`; secret
  // values are never returned by the server.
  setSecrets: (values: Partial<Record<SecretName, string>>) =>
    fetchJson<{ written: SecretName[] }>('/settings/secret', {
      method: 'PUT',
      body: JSON.stringify(values),
    }),
  clearSecret: (name: SecretName) =>
    fetchJson<{ configured: boolean }>(
      `/settings/secret?name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  getSystemStats: () => fetchJson<SystemStats & {
    queue?: QueueStatus | null;
    gallery?: { total: number; recent: GalleryItem[] };
    apiKeyConfigured?: boolean;
    hfTokenConfigured?: boolean;
    civitaiTokenConfigured?: boolean;
    githubTokenConfigured?: boolean;
    pexelsApiKeyConfigured?: boolean;
    uploadMaxBytes?: number;
  }>('/system'),

  getTemplates: () => fetchJson<Template[]>('/templates'),

  /** GET /templates?page=&pageSize=&category=&tags=&q=&source=&ready= — paginated templates. */
  getTemplatesPaged: (
    page: number,
    pageSize: number,
    opts: {
      q?: string;
      category?: string;
      tags?: string[];
      /**
       * `open`  – open-source ComfyUI templates only (openSource !== false).
       * `api`   – API-node workflows requiring an external key.
       * `user`  – user-imported workflows (category === 'User Workflows').
       * `all`   – no filter.
       */
      source?: 'all' | 'open' | 'api' | 'user';
      ready?: 'all' | 'yes' | 'no';
    } = {},
  ) => {
    const extra: Record<string, string> = {};
    if (opts.q) extra.q = opts.q;
    if (opts.category && opts.category !== 'All') extra.category = opts.category;
    if (opts.tags && opts.tags.length > 0) extra.tags = opts.tags.join(',');
    if (opts.source && opts.source !== 'all') extra.source = opts.source;
    if (opts.ready && opts.ready !== 'all') extra.ready = opts.ready;
    return fetchJson<PageEnvelope<Template>>(`/templates?${buildPagedQuery({ page, pageSize, extra })}`);
  },

  /** POST /templates/refresh — re-pull template catalog + recompute readiness. */
  refreshTemplates: () =>
    fetchJson<{ added: number; updated: number; unchanged: number; removed: number }>(
      '/templates/refresh',
      { method: 'POST' },
    ),

  generate: (templateName: string, inputs: Record<string, unknown>, advancedSettings?: Record<string, { proxyIndex: number; value: unknown }>) =>
    fetchJson<{ prompt_id: string }>('/generate', {
      method: 'POST',
      body: JSON.stringify({ templateName, inputs, advancedSettings }),
    }),

  getWorkflowSettings: (templateName: string) =>
    fetchJson<{ settings: AdvancedSetting[] }>(`/workflow-settings/${encodeURIComponent(templateName)}`),

  getTemplateWidgets: (templateName: string) =>
    fetchJson<{ widgets: EnumeratedWidget[]; primitiveFormFields?: FormInput[] }>(
      `/template-widgets/${encodeURIComponent(templateName)}`,
    ),

  /** Single-trip equivalent of `getWorkflowSettings` + `getTemplateWidgets`.
   *  Backend computes the workflow plan once and returns all three payloads
   *  together. */
  getTemplateBundle: (templateName: string) =>
    fetchJson<{
      settings: AdvancedSetting[];
      widgets: EnumeratedWidget[];
      primitiveFormFields?: FormInput[];
    }>(`/template-bundle/${encodeURIComponent(templateName)}`),

  /** Debug/compare: return the /api/prompt payload our converter would produce. */
  getTemplateApiPrompt: (templateName: string, signal?: AbortSignal) =>
    fetchJson<{ templateName: string; apiPrompt: Record<string, unknown> }>(
      `/template-api-prompt/${encodeURIComponent(templateName)}`,
      { signal },
    ),

  saveExposedWidgets: (templateName: string, exposed: Array<{ nodeId: string; widgetName: string }>) =>
    fetchJson<{ exposed: Array<{ nodeId: string; widgetName: string }> }>(`/template-widgets/${encodeURIComponent(templateName)}`, {
      method: 'PUT',
      body: JSON.stringify({ exposed }),
    }),

  getGallery: () => fetchJson<GalleryItem[]>('/gallery'),

  /**
   * Bulk lookup by promptId — used by the chat thread on conversation
   * reload to resolve old `<GeneratedImage>` placeholders to their rendered
   * gallery rows. The server filters at SQL level so we don't load the
   * whole gallery just to filter client-side.
   */
  getGalleryByPromptIds: (ids: string[]) => {
    if (ids.length === 0) return Promise.resolve({ items: [] as GalleryItem[] });
    const qs = new URLSearchParams({ ids: ids.join(',') }).toString();
    return fetchJson<{ items: GalleryItem[] }>(`/gallery/by-prompt-ids?${qs}`);
  },

  /**
   * GET /gallery/:id — full row including `workflowJson`, `promptText`, and
   * KSampler metadata. Wave P split these fat fields off the list payload;
   * the detail modal fetches them on open while falling back to the slim
   * row it received via props for instant display.
   */
  getGalleryItem: (id: string) =>
    fetchJson<GalleryItem>(`/gallery/${encodeURIComponent(id)}`),

  /** GET /gallery?page=&pageSize=&mediaType=&sort= — paginated gallery. */
  getGalleryPaged: (
    page: number,
    pageSize: number,
    opts: { mediaType?: string; sort?: 'newest' | 'oldest' } = {},
  ) => {
    const extra: Record<string, string> = {};
    if (opts.mediaType && opts.mediaType !== 'all') extra.mediaType = opts.mediaType;
    if (opts.sort && opts.sort !== 'newest') extra.sort = opts.sort;
    return fetchJson<PageEnvelope<GalleryItem>>(`/gallery?${buildPagedQuery({ page, pageSize, extra })}`);
  },

  /** DELETE /gallery/:id — remove a single gallery item + its file on disk. */
  deleteGalleryItem: (id: string) =>
    fetchJson<{ deleted: boolean; id: string; fileDeleted?: boolean }>(
      `/gallery/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  /**
   * DELETE /gallery — bulk delete. Body `{ ids: string[] }`. The response
   * includes a per-id `results` array so partial successes are visible.
   */
  bulkDeleteGalleryItems: (ids: string[]) =>
    fetchJson<{
      deleted: number;
      requested: number;
      results: Array<{ id: string; removed: boolean; fileDeleted: boolean; error?: string }>;
    }>('/gallery', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),

  /**
   * POST /gallery/import-from-comfyui — one-shot pull from ComfyUI's
   * `/api/history` list. Rows already present are skipped (INSERT OR
   * IGNORE semantics). Backed by a 10s per-process cooldown; 429 on
   * abuse.
   */
  importGalleryFromComfyUI: () =>
    fetchJson<{ imported: number; skipped: number }>(
      '/gallery/import-from-comfyui',
      { method: 'POST' },
    ),

  /**
   * POST /gallery/:id/regenerate — re-submit the stored workflow JSON,
   * optionally randomising every KSampler seed. Returns 422 when the row
   * was imported before workflow capture was enabled.
   */
  regenerateGalleryItem: (id: string, randomizeSeed = false) =>
    fetchJson<{ promptId: string }>(
      `/gallery/${encodeURIComponent(id)}/regenerate`,
      {
        method: 'POST',
        body: JSON.stringify({ randomizeSeed }),
      },
    ),

  uploadImage: async (file: File): Promise<{ name: string; subfolder: string }> => {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch(`${BASE}/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      // Parse structured error so callers can render a specific toast
      // (e.g. "File too large — max 500 MB" vs "Upload failed").
      let body: unknown = null;
      try { body = await res.json(); } catch { /* non-JSON body */ }
      const msg = (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>))
        ? String((body as { error: unknown }).error)
        : `Upload failed (${res.status})`;
      throw new ApiError(res.status, msg, body);
    }
    return res.json();
  },

  // ---- Launcher / dependency endpoints ----

  checkDependencies: (templateName: string) =>
    fetchJson<DependencyCheck>('/check-dependencies', {
      method: 'POST',
      body: JSON.stringify({ templateName }),
    }),

  /** New unified catalog merged with disk scan. Prefer this for the Models page. */
  getModelsCatalog: () => fetchJson<CatalogModel[]>('/models/catalog'),

  /** GET /models/catalog?page=&pageSize=&q=&type=&installed= — paginated catalog. */
  getModelsCatalogPaged: (
    page: number,
    pageSize: number,
    opts: { q?: string; types?: string[]; installed?: boolean | null } = {},
  ) => {
    const extra: Record<string, string> = {};
    if (opts.q) extra.q = opts.q;
    if (opts.types && opts.types.length > 0) extra.type = opts.types.join(',');
    if (opts.installed === true) extra.installed = 'true';
    else if (opts.installed === false) extra.installed = 'false';
    return fetchJson<PageEnvelope<CatalogModel>>(`/models/catalog?${buildPagedQuery({ page, pageSize, extra })}`);
  },

  scanModels: () =>
    fetchJson<{ success: boolean; count: number }>('/launcher/models/scan', { method: 'POST' }),

  rescanModelIndex: () =>
    fetchJson<{ added: number; removed: number; total: number }>('/models/rescan', { method: 'POST' }),

  getRegisteredFolders: () =>
    fetchJson<string[]>('/models/folders'),

  installModel: (modelName: string) =>
    fetchJson<{ success: boolean; taskId: string; message?: string }>(`/launcher/models/install/${encodeURIComponent(modelName)}`, {
      method: 'POST',
    }),

  cancelDownload: (taskId: string) =>
    fetchJson<void>('/launcher/models/cancel-download', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    }),

  deleteModel: (body: Record<string, unknown>) =>
    fetchJson<void>('/launcher/models/delete', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Kick off a unified download. `opts.meta` is optional; when supplied it
   * pre-populates the catalog so the Models page shows the row with rich
   * metadata + a "Downloading" badge immediately, instead of waiting for
   * the disk scan to pick up the file on completion.
   */
  /**
   * Download a whole HuggingFace repo (used by custom-node entries whose
   * weights are a multi-file package — IndexTTS2 etc.). Server shells out
   * to `huggingface-cli download`. Hooks into the same task/progress WS
   * system as single-file downloads, so the DependencyModal progress bar
   * reuses the existing wire-up.
   */
  downloadHfRepo: (hfRepo: string, directory: string, name?: string) =>
    fetchJson<{ success: boolean; taskId: string; modelName: string }>(
      '/models/download-hf-repo',
      {
        method: 'POST',
        body: JSON.stringify({ hfRepo, directory, name }),
      },
    ),

  downloadCustomModel: (
    hfUrl: string,
    modelDir: string,
    opts?: {
      modelName?: string;
      filename?: string;
      meta?: {
        type?: string;
        description?: string;
        reference?: string;
        size_bytes?: number;
        thumbnail?: string;
        gated?: boolean;
        source?: string;
      };
    },
  ) =>
    fetchJson<{ success: boolean; taskId?: string; alreadyActive?: boolean; message?: string }>('/launcher/models/download-custom', {
      method: 'POST',
      body: JSON.stringify({
        hfUrl,
        modelDir,
        modelName: opts?.modelName,
        filename: opts?.filename,
        meta: opts?.meta,
      }),
    }),

  /** GET /launcher/models/download-history?page=&pageSize= — paginated download history. */
  getDownloadHistoryPaged: (page: number, pageSize: number) =>
    fetchJson<PageEnvelope<Record<string, unknown>> & { success: boolean; count: number }>(
      `/launcher/models/download-history?${buildPagedQuery({ page, pageSize })}`,
    ),

  clearDownloadHistory: () =>
    fetchJson<Record<string, unknown>>('/launcher/models/download-history/clear', {
      method: 'POST',
    }),

  deleteDownloadHistoryEntry: (id: string) =>
    fetchJson<Record<string, unknown>>('/launcher/models/download-history/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  // ---- Launcher process control ----

  startComfyUI: () => fetchJson<{ status: string }>('/launcher/start', { method: 'POST' }),

  stopComfyUI: () => fetchJson<{ status: string }>('/launcher/stop', { method: 'POST' }),

  restartComfyUI: () => fetchJson<{ status: string }>('/launcher/restart', { method: 'POST' }),

  getComfyUILogs: () => fetchJson<{ logs: string }>('/launcher/comfyui/logs'),

  /**
   * POST /comfyui/interrupt — stop the currently-executing prompt. Proxies
   * ComfyUI's `POST /interrupt`. Returns `{ ok: true }` on upstream 2xx;
   * throws on non-ok so the caller can toast the failure.
   */
  interruptExecution: () =>
    fetchJson<{ ok: true }>('/comfyui/interrupt', { method: 'POST' }),

  /**
   * POST /comfyui/queue/delete — remove a pending prompt from ComfyUI's
   * queue by id. Body `{ promptId }`. Proxies ComfyUI's `POST /queue` with
   * `{ delete: [promptId] }`.
   */
  cancelQueuedPrompt: (promptId: string) =>
    fetchJson<{ ok: true }>('/comfyui/queue/delete', {
      method: 'POST',
      body: JSON.stringify({ promptId }),
    }),

  resetComfyUI: (mode: 'normal' | 'hard' = 'normal') =>
    fetchJson<{ success: boolean; message: string; logs?: string[] }>('/launcher/comfyui/reset', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  getResetLogs: () =>
    fetchJson<{ logs: string[]; message?: string }>('/launcher/comfyui/reset-logs'),

  // ---- Settings endpoints ----

  getLaunchOptions: () =>
    fetchJson<Record<string, unknown>>('/launcher/comfyui/launch-options'),

  updateLaunchOptions: (options: Record<string, unknown>) =>
    fetchJson<Record<string, unknown>>('/launcher/comfyui/launch-options', {
      method: 'PUT',
      body: JSON.stringify(options),
    }),

  resetLaunchOptions: () =>
    fetchJson<Record<string, unknown>>('/launcher/comfyui/launch-options/reset', {
      method: 'POST',
    }),

  getNetworkConfig: () =>
    fetchJson<Record<string, unknown>>('/launcher/system/network-config'),

  setHuggingFaceEndpoint: (endpoint: string) =>
    fetchJson<Record<string, unknown>>('/launcher/system/huggingface-endpoint', {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
    }),

  setGithubProxy: (proxy: string) =>
    fetchJson<Record<string, unknown>>('/launcher/system/github-proxy', {
      method: 'POST',
      body: JSON.stringify({ proxy }),
    }),

  setPipSource: (source: string) =>
    fetchJson<Record<string, unknown>>('/launcher/system/pip-source', {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),

  setPluginTrustedHosts: (hosts: string[]) =>
    fetchJson<Record<string, unknown>>('/launcher/system/plugin-trusted-hosts', {
      method: 'POST',
      body: JSON.stringify({ hosts }),
    }),

  setModelTrustedHosts: (hosts: string[]) =>
    fetchJson<Record<string, unknown>>('/launcher/system/model-trusted-hosts', {
      method: 'POST',
      body: JSON.stringify({ hosts }),
    }),

  setAllowPrivateIpMirrors: (allow: boolean) =>
    fetchJson<Record<string, unknown>>('/launcher/system/pip-allow-private-ip', {
      method: 'POST',
      body: JSON.stringify({ allow }),
    }),

  // ---- Plugins (custom nodes) ----
  // See server/src/routes/plugins.routes.ts

  /** GET /plugins?page=&pageSize=&q=&filter= — paginated catalog. */
  getPluginsPaged: (
    page: number,
    pageSize: number,
    opts: { forceRefresh?: boolean; q?: string; filter?: 'all' | 'installed' | 'available' } = {},
  ) => {
    const extra: Record<string, string> = {};
    if (opts.forceRefresh) extra.force = 'true';
    if (opts.q) extra.q = opts.q;
    if (opts.filter && opts.filter !== 'all') extra.filter = opts.filter;
    return fetchJson<PageEnvelope<Plugin>>(`/plugins?${buildPagedQuery({ page, pageSize, extra })}`);
  },

  /** POST /plugins/install — install a plugin by its catalog id. */
  installPlugin: (pluginId: string, githubProxy?: string) =>
    fetchJson<{ success: boolean; message: string; taskId: string }>('/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ pluginId, githubProxy }),
    }),

  /** POST /plugins/uninstall — remove a plugin by id. */
  uninstallPlugin: (pluginId: string) =>
    fetchJson<{ success: boolean; message: string; taskId: string }>('/plugins/uninstall', {
      method: 'POST',
      body: JSON.stringify({ pluginId }),
    }),

  /** POST /plugins/install-custom — git-clone an arbitrary whitelisted URL. */
  installPluginCustom: (githubUrl: string, branch?: string) =>
    fetchJson<{ success: boolean; message: string; taskId: string; pluginId: string }>(
      '/plugins/install-custom',
      {
        method: 'POST',
        body: JSON.stringify({ githubUrl, branch }),
      },
    ),

  /** POST /plugins/switch-version — git-checkout a specific version. */
  switchPluginVersion: (
    pluginId: string,
    targetVersion: { id?: string; version?: string },
    githubProxy?: string,
  ) =>
    fetchJson<{ success: boolean; message: string; taskId: string }>('/plugins/switch-version', {
      method: 'POST',
      body: JSON.stringify({ pluginId, targetVersion, githubProxy }),
    }),

  /** POST /plugins/enable. */
  enablePlugin: (pluginId: string) =>
    fetchJson<{ success: boolean; message: string; taskId: string }>('/plugins/enable', {
      method: 'POST',
      body: JSON.stringify({ pluginId }),
    }),

  /** POST /plugins/disable. */
  disablePlugin: (pluginId: string) =>
    fetchJson<{ success: boolean; message: string; taskId: string }>('/plugins/disable', {
      method: 'POST',
      body: JSON.stringify({ pluginId }),
    }),

  /** GET /plugins/refresh — pull fresh catalog from upstream registry and
   *  re-scan custom_nodes on disk. Falls back to bundled mirror if upstream
   *  is unreachable (signalled by `catalogUpdated: false`). */
  refreshPlugins: () =>
    fetchJson<{
      success: boolean;
      catalogUpdated: boolean;
      upstreamError?: string;
      pluginsCount: number;
      installedCount: number;
    }>('/plugins/refresh'),

  /** GET /plugins/progress/:taskId — poll install/uninstall progress. */
  getPluginProgress: (taskId: string) =>
    fetchJson<PluginTaskProgress>(`/plugins/progress/${encodeURIComponent(taskId)}`),

  /** GET /plugins/logs/:taskId — fetch persisted logs for an operation. */
  getPluginLogs: (taskId: string) =>
    fetchJson<{ success: boolean; logs: string[] }>(`/plugins/logs/${encodeURIComponent(taskId)}`),

  /** GET /plugins/history — recent install/uninstall operations. */
  getPluginHistory: (limit = 100) =>
    fetchJson<{ success: boolean; history: PluginHistoryEntry[] }>(
      `/plugins/history?limit=${limit}`,
    ),

  /** GET /plugins/history?page=&pageSize= — paginated plugin history. */
  getPluginHistoryPaged: (page: number, pageSize: number) =>
    fetchJson<PageEnvelope<PluginHistoryEntry> & { success: boolean }>(
      `/plugins/history?${buildPagedQuery({ page, pageSize })}`,
    ),

  /** POST /plugins/history/clear. */
  clearPluginHistory: () =>
    fetchJson<{ success: boolean; message: string }>('/plugins/history/clear', {
      method: 'POST',
    }),

  /** POST /plugins/history/delete — remove one entry by id. */
  deletePluginHistoryEntry: (id: string) =>
    fetchJson<{ success: boolean; message: string }>('/plugins/history/delete', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  // ---- Python / pip ----
  // See server/src/routes/python.routes.ts

  /** GET /python/pip-source — returns the configured pip index-url as plain text. */
  getPipSource: () => fetchText('/python/pip-source'),

  /** GET /python/packages — list installed pip packages. */
  listPythonPackages: () => fetchJson<PythonPackage[]>('/python/packages'),

  /** POST /python/packages/install — install a pip package (spec may include ==version). */
  installPythonPackage: (pkg: string) =>
    fetchJson<{ success: boolean; message: string; output: string }>('/python/packages/install', {
      method: 'POST',
      body: JSON.stringify({ package: pkg }),
    }),

  /** POST /python/packages/uninstall — uninstall a pip package by bare name. */
  uninstallPythonPackage: (pkg: string) =>
    fetchJson<{ success: boolean; message: string; output: string }>('/python/packages/uninstall', {
      method: 'POST',
      body: JSON.stringify({ package: pkg }),
    }),

  /** GET /python/plugins/dependencies — per-plugin dependency report. */
  getPluginPythonDeps: () =>
    fetchJson<PluginDependencyReport[]>('/python/plugins/dependencies'),

  /** POST /python/plugins/fix-dependencies — pip install -r for one plugin. */
  fixPluginPythonDeps: (plugin: string) =>
    fetchJson<{ success: boolean; message: string; output: string }>(
      '/python/plugins/fix-dependencies',
      {
        method: 'POST',
        body: JSON.stringify({ plugin }),
      },
    ),

  // ---- CivitAI ----
  // See server/src/routes/civitai.routes.ts. Every list endpoint now returns
  // `PageEnvelope<CivitaiModelSummary>`. `total` is a lower bound — civitai
  // does not disclose a total result count; use `hasMore` for pagination.

  /** GET /civitai/models/latest — newest models, non-NSFW by default. */
  getCivitaiLatestModels: (opts: { page?: number; pageSize?: number; cursor?: string } = {}) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/models/latest${buildCivitaiPageQuery(opts)}`,
    ),

  /** GET /civitai/models/hot — most-downloaded-this-month. */
  getCivitaiHotModels: (opts: { page?: number; pageSize?: number; cursor?: string } = {}) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/models/hot${buildCivitaiPageQuery(opts)}`,
    ),

  /**
   * Explore Feed Latest — WORKFLOW listings, not models. Hits
   * `/civitai/latest-workflows` (civitai API `types=Workflows&sort=Newest`).
   */
  getCivitaiLatest: (page: number, pageSize: number, cursor?: string) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/latest-workflows${buildCivitaiPageQuery({ page, pageSize, cursor })}`,
    ),

  /** Explore Feed Hot — workflow listings, most-downloaded last month. */
  getCivitaiHot: (page: number, pageSize: number, cursor?: string) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/hot-workflows${buildCivitaiPageQuery({ page, pageSize, cursor })}`,
    ),

  /**
   * Explore Feed Search — workflow search. Uses `/civitai/search-workflows`
   * which filters civitai's /models endpoint by `types=Workflows`. CivitAI
   * requires cursor-based pagination when `query=` is set.
   */
  searchCivitai: (query: string, cursor?: string, pageSize = 24) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/search-workflows${buildCivitaiPageQuery({ pageSize, cursor, query })}`,
    ),

  /**
   * GET /civitai/models/search — free-text search over civitai models.
   * CivitAI requires cursor-based pagination when `query=` is present, so
   * this method accepts `cursor` from a previous envelope's `nextCursor`.
   */
  searchCivitaiModels: (
    query: string,
    opts: { page?: number; pageSize?: number; cursor?: string } = {},
  ) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/models/search${buildCivitaiPageQuery({ ...opts, query })}`,
    ),

  /** GET /civitai/models/by-url — proxy a CivitAI search URL. */
  getCivitaiByUrl: (url: string, opts: { page?: number; pageSize?: number } = {}) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/models/by-url?url=${encodeURIComponent(url)}${
        opts.page !== undefined ? `&page=${opts.page}` : ''
      }${opts.pageSize !== undefined ? `&pageSize=${opts.pageSize}` : ''}`,
    ),

  /** GET /civitai/download/models/:versionId — version metadata incl. downloadUrl. */
  getCivitaiDownloadInfo: (versionId: string | number) =>
    fetchJson<CivitaiDownloadInfo>(
      `/civitai/download/models/${encodeURIComponent(String(versionId))}`,
    ),

  /** GET /civitai/latest-workflows — newest Workflow-type models. */
  getCivitaiLatestWorkflows: (opts: { page?: number; pageSize?: number; cursor?: string } = {}) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/latest-workflows${buildCivitaiPageQuery(opts)}`,
    ),

  /** GET /civitai/hot-workflows — most-downloaded workflows. */
  getCivitaiHotWorkflows: (opts: { page?: number; pageSize?: number; cursor?: string } = {}) =>
    fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/hot-workflows${buildCivitaiPageQuery(opts)}`,
    ),

  /**
   * POST /templates/import-civitai — pull a workflow version's JSON from
   * civitai and persist as a user template.
   *
   * Response shape depends on the civitai payload:
   *   - Single-JSON / single-workflow-in-zip → commits directly, returns
   *     `CivitaiDirectResponse` (back-compat with the pre-Phase-1 flow).
   *   - Multi-workflow zip → stages the zip, returns `CivitaiStagedResponse`
   *     so the UI can render the review modal.
   */
  importCivitaiWorkflow: (workflowVersionId: string | number) =>
    fetchJson<CivitaiStagedResponse>('/templates/import-civitai', {
      method: 'POST',
      body: JSON.stringify({ workflowVersionId }),
    }),

  /**
   * DELETE /templates/:name — remove a user-imported template. Only succeeds
   * for user workflows (upstream ComfyUI templates return 403).
   */
  deleteTemplate: (name: string) =>
    fetchJson<{ deleted: boolean; name: string }>(
      `/templates/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),

  // ---- Import redesign (Phase 1) ----

  /**
   * POST /templates/import/upload — stage a `.json` or `.zip` file in memory.
   * Returns a `StagedImportManifest` describing discovered workflows + images.
   */
  importWorkflowUpload: async (file: File): Promise<StagedImportManifest> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/templates/import/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `Upload failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  /**
   * POST /templates/import/github — fetch a workflow JSON / zip / walk a
   * public GitHub repo and stage the results. Returns the same manifest
   * shape as `importWorkflowUpload`.
   */
  importWorkflowFromGithub: async (url: string): Promise<StagedImportManifest> => {
    const res = await fetch(`${BASE}/templates/import/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `GitHub import failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  /**
   * POST /templates/import/paste — validate + stage a pasted workflow JSON
   * string. Returns the same manifest shape as `importWorkflowUpload`.
   */
  importWorkflowFromPaste: async (
    json: string, title?: string,
  ): Promise<StagedImportManifest> => {
    const res = await fetch(`${BASE}/templates/import/paste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json, title }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `Paste import failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  /**
   * POST /templates/import/civitai — stage a workflow from a CivitAI URL.
   * Accepts any of the three CivitAI URL shapes (model page, model+version,
   * or api/download/models). Returns the same staging manifest shape as
   * `importWorkflowFromGithub`.
   */
  importWorkflowFromCivitai: async (url: string): Promise<StagedImportManifest> => {
    const res = await fetch(`${BASE}/templates/import/civitai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `CivitAI import failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  /** GET /templates/import/staging/:id — fetch an active staging manifest. */
  getImportStaging: (id: string) =>
    fetchJson<StagedImportManifest>(
      `/templates/import/staging/${encodeURIComponent(id)}`,
    ),

  /**
   * POST /templates/import/staging/:id/commit — write the chosen workflows +
   * (optionally) copy reference images into ComfyUI/input/.
   */
  commitImportStaging: (
    id: string,
    selection: {
      workflowIndices: number[];
      imagesCopy: boolean;
      // Per-index title override used by the "use suggested name" retry
      // after the server returns 409 NAME_COLLISION. Wire shape: numeric
      // index → fresh title.
      titleOverrides?: Record<number, string>;
    },
  ) =>
    fetchJson<{ imported: string[]; imagesCopied: string[] }>(
      `/templates/import/staging/${encodeURIComponent(id)}/commit`,
      {
        method: 'POST',
        body: JSON.stringify(selection),
      },
    ),

  /** DELETE /templates/import/staging/:id — drop the staging row. */
  abortImportStaging: (id: string) =>
    fetchJson<{ aborted: boolean; id: string }>(
      `/templates/import/staging/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  /**
   * POST /templates/import/staging/:id/resolve-model — resolve a missing
   * model via a HuggingFace or CivitAI URL. On success returns the updated
   * manifest so the modal can re-render the newly resolved row inline.
   */
  resolveImportStagingModel: async (
    id: string,
    input: { workflowIndex: number; missingFileName: string; url: string },
  ): Promise<{
    resolved: {
      source: 'huggingface' | 'civitai';
      downloadUrl: string;
      fileName: string;
      sizeBytes?: number;
      suggestedFolder?: string;
    };
    fileName: string;
    manifest: StagedImportManifest | null;
  }> => {
    const res = await fetch(
      `${BASE}/templates/import/staging/${encodeURIComponent(id)}/resolve-model`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error ?? ''; } catch { /* ignore */ }
      throw new Error(detail || `Resolve failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  },

  /**
   * POST /templates/:name/install-missing-plugins — queue installs for every
   * plugin the template requires that isn't already on disk. Returns per-repo
   * task ids the UI can subscribe to via `/plugins/progress/:taskId`.
   */
  installMissingPlugins: (templateName: string) =>
    fetchJson<InstallMissingPluginsResult>(
      `/templates/${encodeURIComponent(templateName)}/install-missing-plugins`,
      { method: 'POST' },
    ),

  /** GET /thumbnail/stats — thumbnail cache summary for the Storage settings row. */
  getThumbnailStats: () =>
    fetchJson<{
      count: number;
      totalBytes: number;
      oldestMtimeMs: number | null;
      bucketCount: number;
    }>('/thumbnail/stats'),

  /** DELETE /thumbnail/cache — admin wipe of the on-disk thumbnail cache. */
  clearThumbnailCache: () =>
    fetchJson<{ deleted: number }>('/thumbnail/cache', { method: 'DELETE' }),

  // ---- Chat / LLM (Ollama) ----

  /** GET /settings/chat — current Ollama URL + default model + keep_alive. */
  getChatSettings: () =>
    fetchJson<{
      ollamaUrl: string;
      defaultModel: string;
      keepAlive: string;
      defaultContextStrategy: ChatContextStrategy;
      advanced: ChatAdvancedSettings;
    }>(
      '/settings/chat',
    ),

  /** PUT /settings/chat — save any subset of the chat config fields. */
  setChatSettings: (patch: Partial<{
    ollamaUrl: string;
    defaultModel: string;
    keepAlive: string;
    defaultContextStrategy: ChatContextStrategy;
    advanced: Partial<ChatAdvancedSettings>;
  }>) =>
    fetchJson<{
      ollamaUrl: string;
      defaultModel: string;
      keepAlive: string;
      defaultContextStrategy: ChatContextStrategy;
      advanced: ChatAdvancedSettings;
    }>(
      '/settings/chat',
      { method: 'PUT', body: JSON.stringify(patch) },
    ),

  /** POST /settings/chat/probe — validate an Ollama URL without saving it. */
  probeChatOllama: (ollamaUrl: string) =>
    fetchJson<{ ok: true; modelCount: number } | { ok: false; error: string }>(
      '/settings/chat/probe',
      { method: 'POST', body: JSON.stringify({ ollamaUrl }) },
    ),

  chat: {
    /** Kick off a streaming chat completion. Returns conversationId + msgId. */
    start: (payload: {
      conversationId?: string;
      model?: string;
      messages: ChatUIMessage[];
      systemPrompt?: string | null;
      /** Optional allow-list of tool names (e.g. ['web_search']). Omit to use
       *  every configured tool. Empty array disables tools for this turn. */
      enabledTools?: string[] | null;
    }) =>
      fetchJson<{ conversationId: string; msgId: string }>('/chat/start', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    listTools: () =>
      fetchJson<{ items: { name: string; label: string; description: string }[] }>(
        '/chat/tools',
      ),

    stop: (msgId: string) =>
      fetchJson<{ aborted: boolean }>(
        `/chat/stop/${encodeURIComponent(msgId)}`,
        { method: 'POST' },
      ),

    listConversations: (opts?: { limit?: number; offset?: number; q?: string }) => {
      const params = new URLSearchParams();
      if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
      if (opts?.q) params.set('q', opts.q);
      const qs = params.toString();
      return fetchJson<{
        items: ChatConversation[]; total: number; hasMore: boolean;
      }>(`/chat/conversations${qs ? `?${qs}` : ''}`);
    },

    getConversation: (id: string) =>
      fetchJson<ChatConversation>(`/chat/conversations/${encodeURIComponent(id)}`),

    getMessages: (id: string) =>
      fetchJson<{ items: ChatMessage[] }>(
        `/chat/conversations/${encodeURIComponent(id)}/messages`,
      ),

    deleteConversation: (id: string) =>
      fetchJson<{ deleted: boolean; id: string }>(
        `/chat/conversations/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),

    /** Drop a single message row. Used by the per-message Trash action in
     *  the thread. Server validates the conversation/message pair so a stale
     *  client can't delete from the wrong chat. */
    deleteMessage: (conversationId: string, msgId: string) =>
      fetchJson<{ deleted: boolean; id: string; msgId: string }>(
        `/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(msgId)}`,
        { method: 'DELETE' },
      ),

    renameConversation: (
      id: string,
      patch: Partial<{ title: string; model: string; system_prompt: string | null }>,
    ) =>
      fetchJson<ChatConversation>(
        `/chat/conversations/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      ),

    listInstalledModels: () =>
      fetchJson<{ models?: OllamaInstalledModel[] }>('/chat/models'),

    getModelInfo: (name: string) =>
      fetchJson<Record<string, unknown>>(
        `/chat/models/info/${encodeURIComponent(name)}`,
      ),

    pullModel: (name: string) =>
      fetchJson<{ taskId: string; alreadyActive: boolean }>(
        '/chat/models/pull',
        { method: 'POST', body: JSON.stringify({ name }) },
      ),

    cancelPull: (name: string) =>
      fetchJson<{ cancelled: boolean }>(
        '/chat/models/pull/cancel',
        { method: 'POST', body: JSON.stringify({ name }) },
      ),

    deleteModel: (name: string) =>
      fetchJson<{ deleted: boolean }>(
        `/chat/models/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),

    listLibrary: () =>
      fetchJson<{ items: OllamaLibraryModel[] }>('/chat/models/library'),

    searchHf: (q: string) =>
      fetchJson<{ items: HfModelSummary[] }>(
        `/chat/models/search-hf?q=${encodeURIComponent(q)}`,
      ),

    /** GET /chat/conversations/:id/usage — current context-window usage state. */
    getUsage: (conversationId: string, model: string, pending = '') => {
      const qs = new URLSearchParams();
      if (model) qs.set('model', model);
      if (pending) qs.set('pending', pending);
      return fetchJson<ChatUsageState>(
        `/chat/conversations/${encodeURIComponent(conversationId)}/usage?${qs.toString()}`,
      );
    },

    /** POST /chat/conversations/:id/compact — manual summarization. */
    compactConversation: (conversationId: string) =>
      fetchJson<{ ok: true; summary: string }>(
        `/chat/conversations/${encodeURIComponent(conversationId)}/compact`,
        { method: 'POST' },
      ),

    /** PATCH /chat/conversations/:id with `{ context_strategy }` only. */
    setStrategy: (conversationId: string, strategy: ChatContextStrategy) =>
      fetchJson<ChatConversation>(
        `/chat/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ context_strategy: strategy }),
        },
      ),
  },
};

// ---- Chat-related shared types ----

export interface ChatUIMessagePart {
  type: string;
  text?: string;
  // `file` parts: image attachments. `mediaType` matches Ollama's `images`
  // contract once the data: prefix is stripped server-side.
  mediaType?: string;
  url?: string;
  // `file` / `file-meta` parts carry attachment metadata so the persisted
  // user message can re-render its chips after a refetch.
  name?: string;
  size?: number;
}

export interface ChatUIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: ChatUIMessagePart[];
}

export type ChatContextStrategy = 'sliding' | 'summarize' | 'manual';

/** Tunables exposed under `advanced` on the chat settings GET/PUT.
 *  Each is a positive number with a server-side validation step; a
 *  cleared/missing value falls back to a documented default. */
export interface ChatAdvancedSettings {
  highWaterPercent: number;
  slidingTargetPercent: number;
  fallbackNumCtx: number;
  maxToolSteps: number;
  loadingHintMs: number;
  keepRecent: number;
  titleTimeoutMs: number;
  summaryTimeoutMs: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  model: string;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
  context_strategy?: ChatContextStrategy;
}

/** Mirrors `UsageState` returned by GET /chat/conversations/:id/usage. */
export interface ChatUsageState {
  used: number;
  budget: number;
  percent: number;
  estimatedNext: number;
  warning: 'green' | 'yellow' | 'red';
  strategy: ChatContextStrategy;
  model: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  parts: ChatUIMessagePart[];
  tokens_in: number | null;
  tokens_out: number | null;
  ms_to_first_token: number | null;
  ms_total: number | null;
  tokens_per_sec: number | null;
  model: string | null;
  created_at: number;
}

// ---- Chat / tools (integrations) ----
// Phase 2 chat-tool framework: each integration is configured server-side and
// only exposed to the LLM when its required URL/key are present. Empty means
// disabled — the chat path simply hides the tool from the model's tool set.

export interface ChatToolsSettings {
  searxngUrl: string;
  ragflowUrl: string;
  ragflowApiKeyConfigured: boolean;
  defaultImageTemplate: string;
}

export interface ChatToolsSettingsInput {
  searxngUrl?: string;
  ragflowUrl?: string;
  ragflowApiKey?: string;
  defaultImageTemplate?: string;
}

export type SearxngProbeResult =
  | { ok: true; resultCount: number }
  | { ok: false; error: string };

// Exposed as a sibling of `api.chat.*` rather than mutating the existing
// literal type, so the original `api.chat` shape stays intact (per the phase-2
// constraint that says "don't touch existing api.chat.* functions"). The
// runtime cast attaches the same handle on `api.chat.tools` for callers that
// already use that path; consumers can pick either form.
export const apiChatTools = {
  getSettings: () => fetchJson<ChatToolsSettings>('/settings/tools'),
  setSettings: (body: ChatToolsSettingsInput) =>
    fetchJson<ChatToolsSettings>('/settings/tools', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  testSearxng: (url: string) =>
    fetchJson<SearxngProbeResult>(
      `/settings/tools/probe-searxng?url=${encodeURIComponent(url)}`,
    ),
};
(api.chat as typeof api.chat & { tools: typeof apiChatTools }).tools = apiChatTools;


export interface OllamaInstalledModel {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: Record<string, unknown>;
}

export interface OllamaLibraryModel {
  name: string;
  title: string;
  description: string;
  pulls: string;
  tagCount: string;
  updated: string;
  sizes: string[];
  capabilities: string[];
}

export interface HfModelSummary {
  id: string;
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  pipeline_tag: string | null;
  tags: string[];
}
