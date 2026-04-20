import type {
  Template,
  SystemStats,
  QueueStatus,
  GalleryItem,
  ModelInfo,
  LauncherModel,
  CatalogModel,
  DependencyCheck,
  AdvancedSetting,
  EnumeratedWidget,
} from '../types';

const BASE = '/api';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const api = {
  health: () => fetchJson<{ status: string }>('/health'),

  getApiKeyStatus: () => fetchJson<{ configured: boolean }>('/settings/api-key'),
  setApiKey: (apiKey: string) =>
    fetchJson<{ configured: boolean }>('/settings/api-key', {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
  clearApiKey: () =>
    fetchJson<{ configured: boolean }>('/settings/api-key', { method: 'DELETE' }),

  getHfTokenStatus: () => fetchJson<{ configured: boolean }>('/settings/hf-token'),
  setHfToken: (token: string) =>
    fetchJson<{ configured: boolean }>('/settings/hf-token', {
      method: 'PUT',
      body: JSON.stringify({ token }),
    }),
  clearHfToken: () =>
    fetchJson<{ configured: boolean }>('/settings/hf-token', { method: 'DELETE' }),

  getSystemStats: () => fetchJson<SystemStats & {
    queue?: QueueStatus | null;
    gallery?: { total: number; recent: GalleryItem[] };
  }>('/system'),

  getTemplates: () => fetchJson<Template[]>('/templates'),

  getTemplate: (name: string) => fetchJson<Template>(`/templates/${encodeURIComponent(name)}`),

  generate: (templateName: string, inputs: Record<string, unknown>, advancedSettings?: Record<string, { proxyIndex: number; value: unknown }>) =>
    fetchJson<{ prompt_id: string }>('/generate', {
      method: 'POST',
      body: JSON.stringify({ templateName, inputs, advancedSettings }),
    }),

  getWorkflowSettings: (templateName: string) =>
    fetchJson<{ settings: AdvancedSetting[] }>(`/workflow-settings/${encodeURIComponent(templateName)}`),

  getTemplateWidgets: (templateName: string) =>
    fetchJson<{ widgets: EnumeratedWidget[] }>(`/template-widgets/${encodeURIComponent(templateName)}`),

  saveExposedWidgets: (templateName: string, exposed: Array<{ nodeId: string; widgetName: string }>) =>
    fetchJson<{ exposed: Array<{ nodeId: string; widgetName: string }> }>(`/template-widgets/${encodeURIComponent(templateName)}`, {
      method: 'PUT',
      body: JSON.stringify({ exposed }),
    }),

  getQueue: () => fetchJson<QueueStatus>('/queue'),

  getHistory: () => fetchJson<Record<string, unknown>>('/history'),

  getModels: () => fetchJson<ModelInfo[]>('/models'),

  getGallery: () => fetchJson<GalleryItem[]>('/gallery'),

  getImageUrl: (filename: string, subfolder?: string) => {
    const params = new URLSearchParams({ filename });
    if (subfolder) params.set('subfolder', subfolder);
    return `${BASE}/view?${params.toString()}`;
  },

  uploadImage: async (file: File): Promise<{ name: string; subfolder: string }> => {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch(`${BASE}/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },

  // ---- Launcher / dependency endpoints ----

  checkDependencies: (templateName: string) =>
    fetchJson<DependencyCheck>('/check-dependencies', {
      method: 'POST',
      body: JSON.stringify({ templateName }),
    }),

  getLauncherModels: () => fetchJson<LauncherModel[]>('/launcher/models'),

  /** New unified catalog merged with disk scan. Prefer this for the Models page. */
  getModelsCatalog: () => fetchJson<CatalogModel[]>('/models/catalog'),

  /** Force a fresh HEAD for a single model's size/gated status. */
  refreshModelSize: (filename: string) =>
    fetchJson<CatalogModel>('/models/catalog/refresh-size', {
      method: 'POST',
      body: JSON.stringify({ filename }),
    }),

  scanModels: () =>
    fetchJson<{ success: boolean; count: number }>('/launcher/models/scan', { method: 'POST' }),

  installModel: (modelName: string) =>
    fetchJson<{ success: boolean; taskId: string; message?: string }>(`/launcher/models/install/${encodeURIComponent(modelName)}`, {
      method: 'POST',
    }),

  getModelProgress: (id: string) =>
    fetchJson<{
      overallProgress: number;
      currentModelProgress: number;
      completed: boolean;
      error: string | null;
      totalBytes: number;
      downloadedBytes: number;
      speed: number;
      status: string;
    }>(`/launcher/models/progress/${encodeURIComponent(id)}`),

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

  downloadCustomModel: (hfUrl: string, modelDir: string, opts?: { modelName?: string; filename?: string }) =>
    fetchJson<{ success: boolean; taskId?: string; alreadyActive?: boolean; message?: string }>('/launcher/models/download-custom', {
      method: 'POST',
      body: JSON.stringify({ hfUrl, modelDir, modelName: opts?.modelName, filename: opts?.filename }),
    }),

  getDownloadHistory: () =>
    fetchJson<Record<string, unknown>>('/launcher/models/download-history'),

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

  getComfyUIStatus: () => fetchJson<{
    running: boolean;
    uptime?: string;
    versions?: { comfyui?: string; frontend?: string; app?: string };
    gpuMode?: string;
  }>('/launcher/status'),

  startComfyUI: () => fetchJson<{ status: string }>('/launcher/start', { method: 'POST' }),

  stopComfyUI: () => fetchJson<{ status: string }>('/launcher/stop', { method: 'POST' }),

  restartComfyUI: () => fetchJson<{ status: string }>('/launcher/restart', { method: 'POST' }),

  getComfyUILogs: () => fetchJson<{ logs: string }>('/launcher/comfyui/logs'),

  resetComfyUI: (mode: 'normal' | 'hard' = 'normal') =>
    fetchJson<{ success: boolean; message: string; logs?: string[] }>('/launcher/comfyui/reset', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  getResetLogs: () =>
    fetchJson<{ logs: string[]; message?: string }>('/launcher/comfyui/reset-logs'),

  getResourcePacks: () => fetchJson<Array<{
    name: string;
    description?: string;
    installed: boolean;
    size?: string;
  }>>('/launcher/resource-packs'),

  getWorkflow: (name: string) =>
    fetchJson<Record<string, unknown>>(`/workflow/${encodeURIComponent(name)}`),

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

  setAllowPrivateIpMirrors: (allow: boolean) =>
    fetchJson<Record<string, unknown>>('/launcher/system/pip-allow-private-ip', {
      method: 'POST',
      body: JSON.stringify({ allow }),
    }),
};
