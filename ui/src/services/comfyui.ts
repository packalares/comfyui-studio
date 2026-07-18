import type {
  Template,
  TemplateSummary,
  SystemStats,
  QueueStatus,
  GalleryItem,
  CatalogModel,
  DependencyCheck,
  AdvancedSetting,
  EnumeratedWidget,
  FormInput,
  WorkflowGroup,
  Plugin,
  PluginTaskProgress,
  PluginHistoryEntry,
  DashboardSummary,
  PythonPackage,
  PluginDependencyReport,
  Pack,
  PackTaskProgress,
  CivitaiModelSummary,
  CivitaiDownloadInfo,
  StagedImportManifest,
  CivitaiStagedResponse,
  CivitaiDirectResponse,
  InstallMissingPluginsResult,
} from '../types';
import { apiCall, apiCallPaginated, type ApiCallPaginatedOutput } from '../api/client';
import { catalogRoutes } from '@server/contracts/catalog.contract';
import { modelsRoutes } from '@server/contracts/models.contract';
import { chatRoutes } from '@server/contracts/chat.contract';
import type { CivitaiFacetsResponse } from '@server/contracts/civitai.contract';
export type { CivitaiFacetsResponse };

const BASE = '/api';

/** Result shape returned by POST /models/enrich. */
export interface EnrichResult {
  success: boolean;
  filename: string;
  metadata_source?: string;
  trigger_words?: string[];
  tags?: string[];
  nsfw_level?: number;
}

/**
 * Build the URL for a locally-cached model preview image.
 * Routes through the unified `/api/thumbnail/model` endpoint (no separate
 * preview route) — gets the same cache + resize + placeholder semantics as
 * gallery / template / URL thumbnails.
 */
export function modelPreviewUrl(save_path: string, filename: string, width = 64): string {
  const qs = new URLSearchParams({ save_path, filename, w: String(width) }).toString();
  return `${BASE}/thumbnail/model?${qs}`;
}

/** Build a /api/download URL for a gallery item. The endpoint streams the
 *  original file with ComfyUI metadata (PNG tEXt / FLAC Vorbis / EXIF / MP4
 *  comment) stripped — use this for user-facing downloads; use item.url
 *  (/api/view) for internal callers that need the raw original. */
export function buildDownloadUrl(item: { filename: string; subfolder: string; type: string }): string {
  const qs = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder, type: item.type });
  return `${BASE}/download?${qs.toString()}`;
}

/** Standard paginated-list response envelope returned by `?page=N` endpoints. */
/** One entry returned by the media-library list endpoint. `ref` is the
 *  `<subfolder>/<filename>` form (or just `<filename>` for legacy root
 *  files) — exactly what ComfyUI's LoadImage / LoadAudio combo expect. */
export interface MediaLibraryItem {
  filename: string;
  subfolder: string;
  ref: string;
  sizeBytes: number;
  mtimeMs: number;
  kind: 'image' | 'audio' | 'video';
  /** Which ComfyUI root this file lives under. Workflow widget mapping uses
   *  this to pick the right loader (standard LoadImage for 'input',
   *  output-aware loader for 'output'). Older server responses without this
   *  field default to 'input' client-side. */
  source: 'input' | 'output';
}

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

// Sibling components frequently mount in parallel and each fetch the same
// status endpoint (Settings/MCP tab is the obvious case — two cards both reading
// slices of /api/system). In-flight GETs to the same URL share one promise so
// the network only sees one request. Mutations always pass through unchanged.
const inflightGets = new Map<string, Promise<unknown>>();

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    const cached = inflightGets.get(url);
    if (cached) return cached as Promise<T>;
  }
  const promise = (async (): Promise<T> => {
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
    const body = await res.json();
    // Auto-unwrap the canonical `{data, meta?}` envelope so legacy callers
    // that pre-date defineRoute continue to receive the raw payload shape.
    // For paginated responses the unwrap re-shapes `{data: items, meta}` into
    // `{items, page, pageSize, total, hasMore}` — the legacy PageEnvelope.
    if (body && typeof body === 'object' && 'data' in body) {
      const d = (body as { data: unknown; meta?: unknown }).data;
      const m = (body as { meta?: unknown }).meta;
      if (m && typeof m === 'object' && Array.isArray(d)) {
        return { items: d, ...(m as object) } as unknown as T;
      }
      return d as T;
    }
    return body as T;
  })();
  if (method === 'GET') {
    inflightGets.set(url, promise);
    promise.finally(() => { inflightGets.delete(url); });
  }
  return promise;
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

/**
 * Mirrors `NetworkConfigView` in
 * `server/src/services/systemLauncher/system.service.ts`. Embedded in
 * `GET /system` under the `network` key.
 */
export interface NetworkReachability {
  url: string;
  accessible: boolean;
  latencyMs?: number;
}
export interface NetworkConfigView {
  huggingfaceEndpoint: string;
  githubProxy: string;
  pipSource: string;
  pluginTrustedHosts: string[];
  modelTrustedHosts: string[];
  allowPrivateIpMirrors: boolean;
  reachability: {
    github: NetworkReachability;
    pip: NetworkReachability;
    huggingface: NetworkReachability;
  };
}

/** Empty-state pills + contextual follow-ups, sourced from the server's
 *  bundled (and optionally user-overridden) default_prompts.md. Sent under
 *  `GET /system.chat.suggestions` so the UI doesn't need its own copy. */
export interface ContextualSuggestionGroups {
  codeFenced: string[];
  question: string[];
  urlBearing: string[];
  fallback: string[];
  longReplyExtra: string;
}
export interface ChatSuggestionsView {
  emptyState: string[];
  contextual: ContextualSuggestionGroups;
}

/** Folded into `GET /system.chat`. The `tools` sub-field replaces the
 *  former `GET /settings/tools` endpoint. */
export interface ChatSettingsView {
  ollamaUrl: string;
  defaultModel: string;
  keepAlive: string;
  defaultContextStrategy: ChatContextStrategy;
  defaultThinkMode: 'on' | 'off' | 'auto';
  advanced: ChatAdvancedSettings;
  tools: ChatToolsSettings;
  suggestions: ChatSuggestionsView;
}

/** Per-key body shapes for the consolidated `PUT /settings/:key` endpoint. */
export interface SettingsPatchByKey {
  secret: Partial<Record<SecretName, string>>;
  chat: Partial<{
    ollamaUrl: string;
    defaultModel: string;
    keepAlive: string;
    defaultContextStrategy: ChatContextStrategy;
    defaultThinkMode: 'on' | 'off' | 'auto';
    advanced: Partial<ChatAdvancedSettings>;
  }>;
  tools: ChatToolsSettingsInput;
  downloads: Partial<{ maxQueue: number; maxConcurrent: number }>;
}

/** Per-key response shapes returned by the consolidated PUT. */
export interface SettingsResponseByKey {
  secret: { written: SecretName[] };
  // PUT /settings/chat doesn't echo `suggestions` (file-driven, not user-set
   // via this endpoint) — the UI reads them from /api/system instead.
   chat: Omit<ChatSettingsView, 'tools' | 'suggestions'>;
  tools: ChatToolsSettings;
  downloads: { maxQueue: number; maxConcurrent: number };
}

export type ProbeType = 'ollama' | 'searxng';
export type ProbeResult =
  | { ok: true; count?: number; version?: string }
  | { ok: false; error: string };

// Shape of a single pending soul-edit proposal, mirroring the server type.
// Exported so the PendingEditsCard component can import it without a separate
// types file.
export interface PendingEdit {
  id: string;
  soulName: string;
  reason: string;
  /** null means append-at-end mode; non-null is the exact text to replace. */
  currentSection: string | null;
  proposedReplacement: string;
  /** Unix milliseconds timestamp of when the model proposed this edit. */
  createdAt: number;
}

// Personality types — the four item flavors the model and the user share.
// `edit` is a pending proposal; the other three are markdown overlays.
export type PersonalityType = 'soul' | 'skill' | 'command' | 'edit';

export interface PersonalitySoul {
  name: string;
  description: string;
}

export interface PersonalitySkill {
  name: string;
  description: string;
  scripts: string[];
}

export interface PersonalityCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface PersonalitySummary {
  souls: PersonalitySoul[];
  skills: PersonalitySkill[];
  commands: PersonalityCommand[];
  defaultSoul: string | null;
  edits: PendingEdit[];
}

export interface PersonalityItemDetail {
  name: string;
  body: string;
  frontmatter: Record<string, unknown>;
  /** Skill-only: list of script files present in the SKILL folder. */
  scripts?: string[];
  /** Command-only: hint string shown next to the slash-menu entry. */
  argumentHint?: string;
}

// Module-level cache for /models/type-map so the UI never re-fetches
// on repeated calls within the same session (the map is server-boot stable).
let _typeMapCache: { types: Record<string, string>; civitaiTypes: Record<string, string> } | null = null;

export const api = {
  // Unified settings writer. Routes return canonical { data: T } envelope.
  updateSettings: async <K extends keyof SettingsPatchByKey>(
    key: K,
    patch: SettingsPatchByKey[K],
  ) => {
    type R = SettingsResponseByKey[K];
    const envelope = await fetchJson<{ data?: R } | R>(`/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return ((envelope as { data?: R }).data ?? envelope) as R;
  },

  // GET /settings/models — read model display settings.
  getModelSettings: async (): Promise<{ nsfwBlurLevel: number }> => {
    const r = await fetchJson<{ data?: { nsfwBlurLevel: number } } | { nsfwBlurLevel: number }>('/settings/models');
    return ((r as { data?: { nsfwBlurLevel: number } }).data ?? r) as { nsfwBlurLevel: number };
  },

  // PUT /settings/models — update model display settings.
  updateModelSettings: async (patch: { nsfwBlurLevel?: number }): Promise<{ nsfwBlurLevel: number }> => {
    const r = await fetchJson<{ data?: { nsfwBlurLevel: number } } | { nsfwBlurLevel: number }>('/settings/models', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return ((r as { data?: { nsfwBlurLevel: number } }).data ?? r) as { nsfwBlurLevel: number };
  },

  // DELETE /settings/secret?name= — clears a named secret.
  deleteSetting: async (key: 'secret', name: SecretName) => {
    const envelope = await fetchJson<{ data?: { configured: boolean } } | { configured: boolean }>(
      `/settings/${key}?name=${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    return ((envelope as { data?: { configured: boolean } }).data ?? envelope) as { configured: boolean };
  },

  // Validate an Ollama or SearXNG URL without persisting it.
  probe: async (type: ProbeType, url: string) => {
    const envelope = await fetchJson<{ data?: ProbeResult } | ProbeResult>('/settings/probe', {
      method: 'POST',
      body: JSON.stringify({ type, url }),
    });
    return ((envelope as { data?: ProbeResult }).data ?? envelope) as ProbeResult;
  },

  getSystemStats: async () => {
    type SystemPayload = SystemStats & {
      queue?: QueueStatus | null;
      comfyuiConnected?: boolean;
      network?: NetworkConfigView | null;
      chat?: ChatSettingsView;
      personality?: PersonalitySummary;
      gallery?: { total: number; recent: GalleryItem[] };
      summary?: DashboardSummary;
      apiKeyConfigured?: boolean;
      hfTokenConfigured?: boolean;
      civitaiTokenConfigured?: boolean;
      githubTokenConfigured?: boolean;
      pexelsApiKeyConfigured?: boolean;
      uploadMaxBytes?: number;
    };
    // Server wraps in { data: {...} } — unwrap the canonical envelope.
    const envelope = await fetchJson<{ data?: SystemPayload } | SystemPayload>('/system');
    return ((envelope as { data?: SystemPayload }).data ?? envelope) as SystemPayload;
  },

  /** @deprecated `/api/templates` is now always paginated. Use
   *  `getTemplatesList()` for the slim bootstrap, `getTemplatesPaged()` for
   *  the Explore grid, or `getTemplateBundle(name)` for one full template. */
  getTemplates: () => fetchJson<PageEnvelope<Template>>('/templates'),

  /** Slim summaries — the AppContext bootstrap shape. */
  getTemplatesList: async () => {
    const env = await fetchJson<{ data?: TemplateSummary[] } | TemplateSummary[]>('/templates/list');
    return ((env as { data?: TemplateSummary[] }).data ?? env) as TemplateSummary[];
  },

  /** GET /templates?page=&pageSize=&category=&tags=&q=&source=&ready= — paginated templates. */
  getTemplatesPaged: async (
    page: number,
    pageSize: number,
    opts: {
      q?: string;
      category?: string;
      tags?: string[];
      source?: 'all' | 'open' | 'api' | 'user' | 'favorites';
      ready?: 'all' | 'yes' | 'no';
    } = {},
  ) => {
    const extra: Record<string, string> = {};
    if (opts.q) extra.q = opts.q;
    if (opts.category && opts.category !== 'All') extra.category = opts.category;
    if (opts.tags && opts.tags.length > 0) extra.tags = opts.tags.join(',');
    if (opts.source && opts.source !== 'all') extra.source = opts.source;
    if (opts.ready && opts.ready !== 'all') extra.ready = opts.ready;
    const env = await fetchJson<{ data?: PageEnvelope<Template> } | PageEnvelope<Template>>(
      `/templates?${buildPagedQuery({ page, pageSize, extra })}`,
    );
    return ((env as { data?: PageEnvelope<Template> }).data ?? env) as PageEnvelope<Template>;
  },

  /** PATCH /templates/:name/favorite — pin / unpin a template. */
  setTemplateFavorite: async (name: string, favorite: boolean) => {
    type R = { name: string; favorite: boolean };
    const env = await fetchJson<{ data?: R } | R>(
      `/templates/${encodeURIComponent(name)}/favorite`,
      { method: 'PATCH', body: JSON.stringify({ favorite }) },
    );
    return ((env as { data?: R }).data ?? env) as R;
  },

  generate: async (
    templateName: string,
    inputs: Record<string, unknown>,
    advancedSettings?: Record<string, { proxyIndex: number; value: unknown }>,
    mode?: string,
  ) => {
    // Server now wraps in { data: { promptId, ... } }. Unwrap and re-expose
    // prompt_id for backward-compat with callers that read result.prompt_id.
    // `mode` is forwarded for Easy-mode templates (the server reads
    // template.studioModes[mode] and mutes inactive nodes before submitting).
    const envelope = await fetchJson<{ data?: { promptId?: string } } | { promptId?: string; prompt_id?: string }>('/generate', {
      method: 'POST',
      body: JSON.stringify({ templateName, inputs, advancedSettings, mode }),
    });
    const inner = (envelope as { data?: Record<string, unknown> }).data ?? (envelope as Record<string, unknown>);
    const promptId = (inner as { promptId?: string }).promptId ?? (inner as { prompt_id?: string }).prompt_id ?? '';
    return { ...inner, promptId, prompt_id: promptId } as { prompt_id: string; promptId: string; [k: string]: unknown };
  },

  getWorkflowSettings: (templateName: string) =>
    fetchJson<{ settings: AdvancedSetting[] }>(`/workflow-settings/${encodeURIComponent(templateName)}`),

  getTemplateWidgets: (templateName: string) =>
    fetchJson<{ widgets: EnumeratedWidget[]; primitiveFormFields?: FormInput[] }>(
      `/template-widgets/${encodeURIComponent(templateName)}`,
    ),

  /** Single-trip equivalent of `getWorkflowSettings` + `getTemplateWidgets`.
   *  Backend computes the workflow plan once and returns all payloads together,
   *  including the stable api-prompt and group assignments.
   *
   *  `builderMeta` is the Easy-mode metadata copied off the TemplateData JSON
   *  for templates that drive the curated Image/Video/Audio builders. It's
   *  optional — most templates won't carry it. */
  getTemplateBundle: (templateName: string) =>
    fetchJson<{
      settings: AdvancedSetting[];
      widgets: EnumeratedWidget[];
      primitiveFormFields?: FormInput[];
      apiPrompt: Record<string, unknown>;
      groups: WorkflowGroup[];
      builderMeta?: {
        studioBuilder?: 'image' | 'video' | 'audio';
        title?: string;
        studioModes?: Record<string, {
          requires?: string[];
          mute?: number[];
          switchNodeId?: number;
          switchSlot?: number;
          triggers?: string[];
          image_format?: Record<string, { standard: [number, number]; hd: [number, number] }>;
          image_format_faster?: Record<string, { standard: [number, number]; hd: [number, number] }>;
        }>;
        promptEnhancer?: {
          systemPrompt: string;
          preferredModel?: string;
          options?: Record<string, unknown>;
          thinking?: boolean;
        };
        prompt_toggles?: Record<string, Record<string, string>>;
      };
      /** Preset display cards — when present, the Studio renders a grid of
       *  preset thumbnails in place of the "Ready when you are" empty panel.
       *  Click handler hits `/api/template-presets/:templateName/:presetId`
       *  (stubbed today; apply-shape wires up later). */
      presets?: Array<{
        id: string;
        title: string;
        description?: string;
        previewUrl?: string;
        published?: boolean;
        tool?: string;
      }>;
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
  getGalleryItem: (
    id: string,
    opts: { mediaType?: string; sort?: 'newest' | 'oldest'; favorite?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.mediaType && opts.mediaType !== 'all') params.set('mediaType', opts.mediaType);
    if (opts.sort && opts.sort !== 'newest') params.set('sort', opts.sort);
    if (opts.favorite) params.set('favorite', 'true');
    const qs = params.toString();
    return fetchJson<GalleryItem>(`/gallery/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`);
  },

  /** GET /gallery?page=&pageSize=&mediaType=&sort=&favorite= — paginated gallery. */
  getGalleryPaged: (
    page: number,
    pageSize: number,
    opts: { mediaType?: string; sort?: 'newest' | 'oldest'; favorite?: boolean } = {},
  ) => {
    const extra: Record<string, string> = {};
    if (opts.mediaType && opts.mediaType !== 'all') extra.mediaType = opts.mediaType;
    if (opts.sort && opts.sort !== 'newest') extra.sort = opts.sort;
    if (opts.favorite) extra.favorite = 'true';
    return fetchJson<PageEnvelope<GalleryItem>>(`/gallery?${buildPagedQuery({ page, pageSize, extra })}`);
  },

  /** PATCH /gallery/:id/favorite — pin / unpin a gallery item. */
  setGalleryFavorite: (id: string, favorite: boolean) =>
    fetchJson<{ id: string; favorite: boolean }>(
      `/gallery/${encodeURIComponent(id)}/favorite`,
      { method: 'PATCH', body: JSON.stringify({ favorite }) },
    ),

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
    fetchJson<{ imported: number; skipped: number; importedFromDisk: number; scanned: number }>(
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
    // Wave 3 envelope: server returns `{ data: { name, subfolder, type } }`.
    // Unwrap so callers read `.name` directly (matches the legacy contract).
    const body = await res.json();
    return (body && typeof body === 'object' && 'data' in body) ? body.data : body;
  },

  // ---- Media library (input/ or output/ contents, used by the Easy-mode media modal) ----
  listMediaLibrary: async (
    kind: 'image' | 'audio' | 'video',
    scope: 'input' | 'output' = 'input',
  ): Promise<MediaLibraryItem[]> => {
    const res = await fetch(`${BASE}/media-library?kind=${kind}&scope=${scope}`);
    if (!res.ok) throw new ApiError(res.status, `List media failed (${res.status})`, null);
    const body = await res.json();
    const data = (body && typeof body === 'object' && 'data' in body) ? body.data : body;
    // Older servers omit `source`; default to the requested scope so the
    // client always has a definite branch value.
    return ((data?.items ?? []) as MediaLibraryItem[])
      .map((it) => ({ ...it, source: it.source ?? scope }));
  },
  uploadMediaLibrary: async (
    file: File, kind: 'image' | 'audio' | 'video',
  ): Promise<MediaLibraryItem> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${BASE}/media-library?kind=${kind}`, { method: 'POST', body: form });
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.json(); } catch { /* non-JSON */ }
      const msg = (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>))
        ? String((body as { error: unknown }).error)
        : `Upload failed (${res.status})`;
      throw new ApiError(res.status, msg, body);
    }
    const body = await res.json();
    return ((body && typeof body === 'object' && 'data' in body) ? body.data : body) as MediaLibraryItem;
  },
  deleteMediaLibrary: async (filename: string, subfolder: string): Promise<void> => {
    const qs = new URLSearchParams({ filename, subfolder });
    const res = await fetch(`${BASE}/media-library?${qs.toString()}`, { method: 'DELETE' });
    if (!res.ok) throw new ApiError(res.status, `Delete failed (${res.status})`, null);
  },

  // ---- Launcher / dependency endpoints ----

  checkDependencies: (templateName: string) =>
    fetchJson<DependencyCheck>('/check-dependencies', {
      method: 'POST',
      body: JSON.stringify({ templateName }),
    }),

  /** Merged catalog + disk scan. No `?page=` — returns full flat array. */
  getModelsCatalog: () =>
    apiCall(catalogRoutes.list, { query: {} }),

  /** Sidebar aggregates — installed count, disk usage, distinct types. */
  getModelsStats: () =>
    apiCall(catalogRoutes.stats, {}),

  /** GET /models/catalog?page=&pageSize=&q=&type=&installed=&filenames= — paginated catalog. */
  getModelsCatalogPaged: (
    page: number,
    pageSize: number,
    opts: { q?: string; types?: string[]; installed?: boolean | null; filenames?: string[] } = {},
  ): Promise<ApiCallPaginatedOutput<typeof catalogRoutes.list>> => {
    const query: {
      page: number; pageSize: number;
      q?: string; type?: string;
      installed?: 'true' | 'false';
      filenames?: string;
    } = { page, pageSize };
    if (opts.q) query.q = opts.q;
    if (opts.types && opts.types.length > 0) query.type = opts.types.join(',');
    if (opts.installed === true) query.installed = 'true';
    else if (opts.installed === false) query.installed = 'false';
    if (opts.filenames && opts.filenames.length > 0) query.filenames = opts.filenames.join(',');
    return apiCallPaginated(catalogRoutes.list, { query });
  },

  /** GET /models/used-by?filename= — templates whose workflow references this basename. */
  getModelUsedBy: (filename: string) =>
    apiCall(modelsRoutes.usedBy, { query: { filename } }),

  scanModels: () =>
    apiCall(modelsRoutes.scan, {}),

  rescanModelIndex: () =>
    apiCall(modelsRoutes.rescan, {}),

  getRegisteredFolders: () =>
    apiCall(modelsRoutes.folders, {}),

  cancelDownload: (taskId: string) =>
    apiCall(modelsRoutes.cancelDownload, { body: { taskId } }),

  /** Delete a model from disk. Identifier is polymorphic — prefer
   *  (save_path, filename) so name collisions can't pick the wrong row.
   *  Server falls back to modelName for backward compatibility. */
  deleteModel: (
    id: { save_path?: string; filename?: string; modelName?: string; sha256?: string; abs_path?: string },
  ) =>
    apiCall(modelsRoutes.deleteModel, { body: id }),

  /** Download a whole HuggingFace repo snapshot. */
  downloadHfRepo: (hfRepo: string, directory: string, name?: string) =>
    apiCall(modelsRoutes.downloadHfRepo, { body: { hfRepo, directory, name } }),

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
    apiCall(modelsRoutes.downloadCustom, {
      body: { hfUrl, modelDir, modelName: opts?.modelName, filename: opts?.filename, meta: opts?.meta },
    }),

  /** GET /models/download-history?page=&pageSize= — paginated download history. */
  getDownloadHistoryPaged: (page: number, pageSize: number): Promise<ApiCallPaginatedOutput<typeof modelsRoutes.downloadHistory>> =>
    apiCallPaginated(modelsRoutes.downloadHistory, { query: { page, pageSize } }),

  clearDownloadHistory: () =>
    apiCall(modelsRoutes.downloadHistoryClear, {}),

  deleteDownloadHistoryEntry: (id: string) =>
    apiCall(modelsRoutes.downloadHistoryDelete, { body: { id } }),

  // ---- Model enrichment ----

  /** Enrich a single model. source defaults to 'auto' (CivitAI hash then HF fallback). */
  enrichModel: (
    save_path: string,
    filename: string,
    source?: 'auto' | 'civitai' | 'huggingface',
  ) =>
    fetchJson<{ data?: EnrichResult } | EnrichResult>('/models/enrich', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ save_path, filename, ...(source ? { source } : {}) }),
    }).then((r) => ((r as { data?: EnrichResult }).data ?? r) as EnrichResult),

  /** Kick off the background SHA256 hash queue for all un-hashed models. */
  enrichAllModels: () =>
    fetchJson<{ data?: { enqueued: number; message: string } }>('/models/enrich-all', {
      method: 'POST',
    }).then((r) => (r as { data?: { enqueued: number; message: string } }).data ?? r as { enqueued: number; message: string }),

  /** Toggle favorite on a model sidecar (no CivitAI round-trip). */
  setModelFavorite: (save_path: string, filename: string, favorite: boolean) =>
    fetchJson<{ data?: { success: boolean; filename: string; favorite: boolean } }>(
      '/models/enrichment/favorite',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save_path, filename, favorite }),
      },
    ).then((r) => (r as { data?: { success: boolean; filename: string; favorite: boolean } }).data
      ?? r as { success: boolean; filename: string; favorite: boolean }),

  // ---- Launcher process control ----
  // All lifecycle routes use defineRoute and return { data: T } — unwrap inline.

  startComfyUI: async () => {
    type R = { success: boolean; status?: string; message?: string };
    const env = await fetchJson<{ data?: R } | R>('/start', { method: 'POST' });
    return ((env as { data?: R }).data ?? env) as R;
  },
  stopComfyUI: async () => {
    type R = { success: boolean; status?: string; message?: string };
    const env = await fetchJson<{ data?: R } | R>('/stop', { method: 'POST' });
    return ((env as { data?: R }).data ?? env) as R;
  },
  restartComfyUI: async () => {
    type R = { success: boolean; status?: string; message?: string };
    const env = await fetchJson<{ data?: R } | R>('/restart', { method: 'POST' });
    return ((env as { data?: R }).data ?? env) as R;
  },
  getComfyUILogs: async () => {
    type R = { logs: string[] };
    const env = await fetchJson<{ data?: R } | R>('/comfyui/logs');
    return ((env as { data?: R }).data ?? env) as R;
  },
  interruptExecution: async () => {
    type R = { ok: true };
    const env = await fetchJson<{ data?: R } | R>('/comfyui/interrupt', { method: 'POST' });
    return ((env as { data?: R }).data ?? env) as R;
  },
  cancelQueuedPrompt: async (promptId: string) => {
    type R = { ok: true };
    const env = await fetchJson<{ data?: R } | R>('/comfyui/queue/delete', {
      method: 'POST',
      body: JSON.stringify({ promptId }),
    });
    return ((env as { data?: R }).data ?? env) as R;
  },
  resetComfyUI: async (mode: 'normal' | 'hard' = 'normal') => {
    type R = { success: boolean; message: string; logs?: string[] };
    const env = await fetchJson<{ data?: R } | R>('/comfyui/reset', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    return ((env as { data?: R }).data ?? env) as R;
  },
  getResetLogs: async () => {
    type R = { logs: string[]; message?: string };
    const env = await fetchJson<{ data?: R } | R>('/comfyui/reset-logs');
    return ((env as { data?: R }).data ?? env) as R;
  },

  // ---- Settings endpoints ----

  getLaunchOptions: () =>
    fetchJson<Record<string, unknown>>('/comfyui/launch-options'),

  updateLaunchOptions: (options: Record<string, unknown>) =>
    fetchJson<Record<string, unknown>>('/comfyui/launch-options', {
      method: 'PUT',
      body: JSON.stringify(options),
    }),

  resetLaunchOptions: () =>
    fetchJson<Record<string, unknown>>('/comfyui/launch-options/reset', {
      method: 'POST',
    }),

  // Single dispatch helper for every network-config write. The server's
  // `POST /system/:key` route maps each key to a configurator setter; the
  // UI just ships `{ value }` and the type matches the matching setter.
  // Response is now canonical { data: { success, message, data } }.
  setSystemConfig: (key: string, value: unknown) =>
    fetchJson<{ data: { success: boolean; message: string; data: unknown } }>(
      `/system/${encodeURIComponent(key)}`,
      { method: 'POST', body: JSON.stringify({ value }) },
    ),

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

  // ---- Capability packs ----
  // See server/src/routes/packs.routes.ts

  /** GET /packs — registry merged with installed state. */
  getPacks: () => fetchJson<{ items: Pack[] }>('/packs'),

  /** POST /packs/:id/install — kick off pip+model install, fire-and-forget. */
  installPack: (id: string) =>
    fetchJson<{ taskId: string }>(`/packs/${encodeURIComponent(id)}/install`, {
      method: 'POST',
    }),

  /** POST /packs/:id/uninstall — flip install state off. */
  uninstallPack: (id: string) =>
    fetchJson<{ taskId: string }>(`/packs/${encodeURIComponent(id)}/uninstall`, {
      method: 'POST',
    }),

  /** GET /packs/progress/:taskId — poll install/uninstall progress. */
  getPackProgress: (taskId: string) =>
    fetchJson<PackTaskProgress>(`/packs/progress/${encodeURIComponent(taskId)}`),

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
  // See server/src/routes/civitai.routes.ts. Every list endpoint returns
  // `PageEnvelope<CivitaiModelSummary>`. `total` is a lower bound — civitai
  // does not disclose a total result count; use `hasMore` for pagination.
  //
  // The legacy `getCivitaiLatestModels` / `getCivitaiHotModels` helpers were
  // dropped along with the `/civitai/models/{latest,hot}` routes in favour
  // of the faceted /civitai/models/search endpoint. Sort=Newest replaces the
  // old "latest" feed; sort=Most Downloaded + period=Month replaces "hot".

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
   * GET /civitai/models/search — free-text + faceted search. `query` may be
   * empty when at least one filter is set (filter-only browses are a valid
   * use case — "show me all LoRAs for Qwen Image"). CivitAI requires
   * cursor-based pagination as soon as either `query=` OR one of the array
   * filters is present.
   */
  searchCivitaiModels: (
    query: string,
    opts: {
      page?: number; pageSize?: number; cursor?: string;
      types?: string[]; baseModels?: string[];
      nsfw?: boolean; period?: string; sort?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.pageSize !== undefined) params.set('pageSize', String(opts.pageSize));
    if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
    else if (opts.page !== undefined) params.set('page', String(opts.page));
    if (query.length > 0) params.set('q', query);
    for (const t of opts.types ?? []) params.append('types[]', t);
    for (const b of opts.baseModels ?? []) params.append('baseModels[]', b);
    if (opts.nsfw !== undefined) params.set('nsfw', String(opts.nsfw));
    if (opts.period) params.set('period', opts.period);
    if (opts.sort) params.set('sort', opts.sort);
    const qs = params.toString();
    return fetchJson<PageEnvelope<CivitaiModelSummary>>(
      `/civitai/models/search${qs ? `?${qs}` : ''}`,
    );
  },

  /** GET /civitai/models/facets — vocabulary for the search-sidebar chips.
   *  `baseModels` is dynamic (probed off CivitAI's Most-Downloaded slice);
   *  `types`, `periods`, `sorts` are CivitAI's documented enums. */
  getCivitaiFacets: async (): Promise<CivitaiFacetsResponse> => {
    const env = await fetchJson<{ data?: CivitaiFacetsResponse } | CivitaiFacetsResponse>(
      '/civitai/models/facets',
    );
    return ((env as { data?: CivitaiFacetsResponse }).data ?? env) as CivitaiFacetsResponse;
  },

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
  installMissingPlugins: async (templateName: string) => {
    const env = await fetchJson<{ data?: InstallMissingPluginsResult } | InstallMissingPluginsResult>(
      `/templates/${encodeURIComponent(templateName)}/install-missing-plugins`,
      { method: 'POST' },
    );
    return ((env as { data?: InstallMissingPluginsResult }).data ?? env) as InstallMissingPluginsResult;
  },

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
  // CRUD endpoints use apiCall(chatRoutes.X, input) for typed envelopes.
  // Model management (installModel, pullModel, etc.) stays on fetchJson.

  chat: {
    /** Kick off a streaming chat completion. Returns conversationId + msgId. */
    start: (payload: {
      conversationId?: string;
      model?: string;
      messages: ChatUIMessage[];
      soulName?: string | null;
      enabledTools?: string[] | null;
      initialContextStrategy?: ChatContextStrategy;
      initialThinkMode?: 'on' | 'off' | null;
      initialNumCtx?: number | null;
      initialTemperature?: number | null;
      initialFormat?: 'json' | null;
    }) =>
      apiCall(chatRoutes.start, {
        body: {
          ...payload,
          messages: payload.messages as unknown as { id: string; role: 'user' | 'assistant' | 'system'; parts: Record<string, unknown>[] }[],
        },
      }),

    stop: (msgId: string) =>
      apiCall(chatRoutes.stop, { params: { msgId } }),

    listConversations: (opts?: { page?: number; pageSize?: number; limit?: number; offset?: number; q?: string }) => {
      const pageSize = opts?.pageSize ?? opts?.limit ?? 20;
      const page = opts?.page ?? (opts?.offset !== undefined ? Math.floor(opts.offset / pageSize) + 1 : 1);
      return apiCall(chatRoutes.listConversations, {
        query: { page, pageSize, q: opts?.q },
      }).then((items) => ({ items, total: items.length, hasMore: false }));
    },

    getConversation: (id: string, model?: string) =>
      apiCall(chatRoutes.getConversation, { params: { id }, query: { model } }),

    getMessages: (id: string, opts?: { limit?: number; before?: string }) =>
      apiCall(chatRoutes.getMessages, {
        params: { id },
        query: { limit: opts?.limit, before: opts?.before },
      }).then((r) => ({ ...r, items: r.items as unknown as ChatMessage[] })),

    deleteConversation: (id: string) =>
      apiCall(chatRoutes.deleteConversation, { params: { id } }),

    deleteAllConversations: () => apiCall(chatRoutes.deleteAllConversations, {}),

    deleteMessage: (conversationId: string, msgId: string) =>
      apiCall(chatRoutes.deleteMessage, { params: { id: conversationId, msgId } }),

    renameConversation: (
      id: string,
      patch: Partial<{
        title: string; model: string; soul_name: string | null; pinned: boolean;
        context_strategy: ChatContextStrategy; num_ctx: number | null;
        think_mode: 'on' | 'off' | null; temperature: number | null; format: 'json' | null;
      }>,
    ) => apiCall(chatRoutes.patchConversation, { params: { id }, body: patch }),

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

    // Body-based shape: HF-style names contain `/` (e.g.
    // `hf.co/owner/repo:tag`), which encodeURIComponent turns into `%2F`.
    // nginx-ingress rejects URLs with encoded slashes in the path with a
    // 400 before they reach Studio. Sending the name in the JSON body
    // sidesteps the path-encoding rule entirely.
    deleteModel: (name: string) =>
      fetchJson<{ deleted: boolean }>(
        '/chat/models',
        { method: 'DELETE', body: JSON.stringify({ name }) },
      ),

    listLibrary: (opts?: { q?: string; page?: number; pageSize?: number }) => {
      const params = new URLSearchParams();
      if (opts?.q) params.set('q', opts.q);
      if (opts?.page) params.set('page', String(opts.page));
      if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
      const qs = params.toString();
      return fetchJson<{
        items: OllamaLibraryModel[];
        total: number;
        page: number;
        pageSize: number;
        fetchedAt: number;
      }>(`/chat/models/library${qs ? `?${qs}` : ''}`);
    },

    refreshLibrary: () =>
      fetchJson<{ replaced: boolean; total: number }>(
        '/chat/models/library/refresh',
        { method: 'POST' },
      ),

    getLibraryTags: (name: string) =>
      fetchJson<{ tags: OllamaTagEntry[] }>(
        `/chat/models/library/${encodeURIComponent(name)}/tags`,
      ),

    searchHf: (q: string) =>
      fetchJson<{ items: HfModelSummary[] }>(
        `/chat/models/search-hf?q=${encodeURIComponent(q)}`,
      ),

    getUsage: (conversationId: string, model: string, pending = '') =>
      apiCall(chatRoutes.getUsage, {
        params: { id: conversationId },
        query: { model: model || undefined, pending: pending || undefined },
      }),

    compactConversation: (conversationId: string) =>
      apiCall(chatRoutes.compact, { params: { id: conversationId } }),

    setStrategy: (conversationId: string, strategy: ChatContextStrategy) =>
      apiCall(chatRoutes.patchConversation, {
        params: { id: conversationId },
        body: { context_strategy: strategy },
      }),

    setNumCtx: (conversationId: string, numCtx: number | null) =>
      apiCall(chatRoutes.patchConversation, {
        params: { id: conversationId },
        body: { num_ctx: numCtx },
      }),

    setThinkMode: (conversationId: string, thinkMode: 'on' | 'off' | null) =>
      apiCall(chatRoutes.patchConversation, {
        params: { id: conversationId },
        body: { think_mode: thinkMode },
      }),

    setTemperature: (conversationId: string, temperature: number | null) =>
      apiCall(chatRoutes.patchConversation, {
        params: { id: conversationId },
        body: { temperature },
      }),

    setFormat: (conversationId: string, format: 'json' | null) =>
      apiCall(chatRoutes.patchConversation, {
        params: { id: conversationId },
        body: { format },
      }),
  },

  // ---- Personality (souls, skills, commands, edits, memory) ----
  //
  // Reads: prefer `useSystem().personality` — it's hydrated from the same
  // /api/system payload that the app already fetches at boot. These helpers
  // are for direct refreshes (e.g. after a mutation) and for the small number
  // of consumers that need a single item's full body (not in the summary).
  personality: {
    getSummary: async () => {
      const env = await fetchJson<{ data?: PersonalitySummary } | PersonalitySummary>('/personality');
      return ((env as { data?: PersonalitySummary }).data ?? env) as PersonalitySummary;
    },
    get: async (type: PersonalityType, name: string) => {
      const env = await fetchJson<{ data?: PersonalityItemDetail } | PersonalityItemDetail>(
        `/personality/${type}/${encodeURIComponent(name)}`,
      );
      return ((env as { data?: PersonalityItemDetail }).data ?? env) as PersonalityItemDetail;
    },
    put: async (type: 'soul' | 'skill' | 'command', name: string, body: string) => {
      type R = { ok: true };
      const env = await fetchJson<{ data?: R } | R>(
        `/personality/${type}/${encodeURIComponent(name)}`,
        { method: 'PUT', body: JSON.stringify({ body }) },
      );
      return ((env as { data?: R }).data ?? env) as R;
    },
    delete: async (type: PersonalityType, name: string) => {
      type R = { ok: true };
      const env = await fetchJson<{ data?: R } | R>(
        `/personality/${type}/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      return ((env as { data?: R }).data ?? env) as R;
    },
    acceptEdit: async (id: string) => {
      type R = { ok: boolean; soulName?: string };
      const env = await fetchJson<{ data?: R } | R>(
        `/personality/edit/${encodeURIComponent(id)}`,
        { method: 'POST', body: JSON.stringify({ action: 'accept' }) },
      );
      return ((env as { data?: R }).data ?? env) as R;
    },
    getMemory: async () => {
      type R = { body: string };
      const env = await fetchJson<{ data?: R } | R>('/personality/memory');
      return ((env as { data?: R }).data ?? env) as R;
    },
    putMemory: async (body: string) => {
      type R = { ok: true };
      const env = await fetchJson<{ data?: R } | R>('/personality/memory', {
        method: 'PUT',
        body: JSON.stringify({ body }),
      });
      return ((env as { data?: R }).data ?? env) as R;
    },
  },

  /** GET /models/type-map — returns the catalog-type → subdir maps used by
   *  the install handler and folder-picker. Cached at module level so repeated
   *  calls don't refetch. Falls back to an empty map on network failure so the
   *  UI doesn't crash. */
  getTypeMap: async (): Promise<{ types: Record<string, string>; civitaiTypes: Record<string, string> }> => {
    if (_typeMapCache) return _typeMapCache;
    try {
      type R = { types: Record<string, string>; civitaiTypes: Record<string, string> };
      const env = await fetchJson<{ data?: R } | R>('/models/type-map');
      const result = ((env as { data?: R }).data ?? env) as R;
      _typeMapCache = result;
      return result;
    } catch {
      return { types: {}, civitaiTypes: {} };
    }
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

export type ChatContextStrategy = 'sliding' | 'auto';

/** Tunables exposed under `advanced` on the chat settings GET/PUT.
 *  Each is a positive number with a server-side validation step; a
 *  cleared/missing value falls back to a documented default. */
export interface ChatAdvancedSettings {
  highWaterPercent: number;
  maxToolSteps: number;
  loadingHintMs: number;
  keepRecent: number;
  titleTimeoutMs: number;
  summaryTimeoutMs: number;
  /** When true, fire a small post-turn LLM call to generate dynamic
   *  follow-up suggestion pills. Off → static heuristic only. */
  smartSuggestions: boolean;
}

export interface ChatConversation {
  id: string;
  title: string;
  model: string;
  soul_name: string | null;
  created_at: number;
  updated_at: number;
  context_strategy?: ChatContextStrategy;
  /** Whether this conversation is pinned to the top of the list. */
  pinned?: boolean;
  /** Server-computed usage for this conv at hydrate time (only present on
   *  GET /chat/conversations/:id, not on the list endpoint). Lets the meter
   *  UI render without a separate /usage round-trip. May be null when the
   *  model param resolved empty or the upstream call failed. */
  usage?: ChatUsageState | null;
}

/** Mirrors `UsageState` returned by GET /chat/conversations/:id/usage. */
export interface ChatUsageState {
  used: number;
  /** `null` when on Auto AND the model isn't currently loaded — UI shows
   *  an "Auto" placeholder until the next request lands. */
  budget: number | null;
  percent: number;
  estimatedNext: number;
  warning: 'green' | 'yellow' | 'red';
  strategy: ChatContextStrategy;
  model: string;
  /** Model's published architectural max context (e.g. 131072 for llama3.1).
   *  `null` when /api/show is unreachable. Used as the slider upper bound. */
  modelMaxCtx: number | null;
  /** Per-conversation runtime override. `null` = use Ollama default. */
  numCtx: number | null;
  /** Per-conversation reasoning-mode override. `null` = auto. */
  thinkMode: 'on' | 'off' | null;
  /** Per-conversation sampling temperature. `null` = Ollama default. */
  temperature: number | null;
  /** Per-conversation output format. `null` = text; `'json'` = JSON. */
  format: 'json' | null;
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
  /** Cold-load latency Ollama reported for this turn (ms). Nonzero only
   *  when the model wasn't already in VRAM; near-zero otherwise. */
  load_duration_ms: number | null;
  model: string | null;
  created_at: number;
}

// ---- Chat / tools (integrations) ----
// Phase 2 chat-tool framework: each integration is configured server-side and
// only exposed to the LLM when its required URL/key are present. Empty means
// disabled — the chat path simply hides the tool from the model's tool set.

export interface ChatToolListing {
  name: string;
  label: string;
  description: string;
}

export interface ChatToolsSettings {
  searxngUrl: string;
  defaultImageTemplate: string;
  /** Resolved chat-composer tool list (replaces /api/chat/tools). Empty when
   *  no integrations are configured / ready. */
  availableTools: ChatToolListing[];
}

export interface ChatToolsSettingsInput {
  searxngUrl?: string;
  defaultImageTemplate?: string;
}


export interface OllamaInstalledModel {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: Record<string, unknown>;
  /** Server-attached: capabilities for this model's base name (e.g.
   *  `['vision']`, `['tools']`). Looked up from the cached ollama_library
   *  table; empty array when the model isn't in the catalog. */
  capabilities?: string[];
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

export interface OllamaTagEntry {
  /** The tag string (e.g. `8b`, `70b-instruct-q4_K_M`, `latest`). */
  tag: string;
  size: string;
  contextLength: string;
  input: string;
  digest: string;
  updated: string;
}

export interface HfModelSummary {
  id: string;
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  pipeline_tag: string | null;
  tags: string[];
}

// ---- Skills + Commands shared types ----

