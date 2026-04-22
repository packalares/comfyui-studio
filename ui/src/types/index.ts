export interface GpuInfo {
  name: string;
  vram_total: number;
  vram_free: number;
  vram_used: number;
  temperature?: number;
  utilization?: number;
}

export interface MonitorStats {
  cpu_utilization?: number;
  ram_total?: number;
  ram_used?: number;
  ram_used_percent?: number;
  hdd_total?: number;
  hdd_used?: number;
  hdd_used_percent?: number;
  device_type?: string;
}

export interface SystemStats {
  system: {
    os: string;
    python_version: string;
    pytorch_version: string;
    comfyui_version?: string;
  };
  devices: GpuInfo[];
}

export interface TemplateInput {
  nodeId: number;
  nodeType: string;
  file?: string;
  mediaType: string;
  fieldName?: string;
  label?: string;
  default?: string | number;
  min?: number;
  max?: number;
}

export interface TemplateOutput {
  nodeId: number;
  nodeType: string;
  file: string;
  mediaType: string;
}

export interface FormInput {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'image' | 'audio' | 'video' | 'number' | 'slider' | 'select' | 'toggle';
  required: boolean;
  description?: string;
  placeholder?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  nodeId?: number;
  nodeType?: string;
  mediaType?: string;
  /**
   * Workflow-level binding for prompt-surface fields (`text` / `tags` /
   * `lyrics` / ...). Set by the server's workflow-reading form-input path;
   * used by the Studio page to pre-fill from the matching widget's default
   * and by the server's generate pipeline to route the value onto the
   * specific (nodeId, widgetName) instead of fanning across every
   * multiline STRING widget on the first eligible node.
   */
  bindNodeId?: string;
  bindWidgetName?: string;
}

export type StudioCategory = 'image' | 'video' | 'audio' | '3d' | 'tools';

/**
 * Resolved plugin entry attached to a Template. Mirrors the backend's
 * `TemplatePluginEntry` wire shape. `installed` is a frontend-applied
 * overlay that the template list endpoint will populate once Phase 2
 * backend plumbing (template_plugins edges + plugin catalog overlay) is
 * wired into the explorer list.
 */
export interface TemplatePlugin {
  repo: string;
  title: string;
  cnr_id?: string;
  installed?: boolean;
}

/**
 * CivitAI origin metadata for a user-imported template. Populated by the
 * Wave J CivitAI URL import flow; surfaced on the TemplateCard as a
 * source badge + first-three tags row.
 */
export interface TemplateCivitaiMeta {
  modelId: number;
  tags?: string[];
  description?: string;
  originalUrl?: string;
}

export interface Template {
  name: string;
  title: string;
  description: string;
  mediaType: string;
  tags: string[];
  models: string[];
  /**
   * Custom-node plugins this template requires (resolved at import/refresh
   * time). Optional — legacy rows and upstream ComfyUI templates may omit
   * it entirely, in which case the UI shows no "plugins missing" chip.
   */
  plugins?: TemplatePlugin[];
  category: string;
  studioCategory?: StudioCategory;
  io: {
    inputs: TemplateInput[];
    outputs: TemplateOutput[];
  };
  formInputs?: FormInput[];
  thumbnail: string[];
  thumbnailVariant?: string;
  workflow?: Record<string, unknown>;
  size?: number;
  vram?: number;
  usage?: number;
  openSource?: boolean;
  username?: string;
  date?: string;
  logos?: string[];
  /**
   * True when every required model + plugin is installed on disk. Emitted by
   * the backend from the `templates.installed` column; `false` when unknown.
   */
  ready?: boolean;
  /**
   * CivitAI origin metadata. Only populated for user-imported templates
   * that came in through the CivitAI URL tab.
   */
  civitaiMeta?: TemplateCivitaiMeta;
}

export interface QueueStatus {
  queue_running: number;
  queue_pending: number;
}

export interface GenerationJob {
  id: string;
  templateName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  inputs: Record<string, unknown>;
  outputs?: GenerationOutput[];
  outputUrl?: string;
  outputMediaType?: string;
  createdAt: string;
  completedAt?: string;
  seed?: number;
  timeTaken?: number;
  error?: string;
}

export interface GenerationOutput {
  filename: string;
  subfolder: string;
  type: string;
  mediaType: string;
}

export interface GalleryItem {
  id: string;
  filename: string;
  subfolder: string;
  type?: string;
  mediaType: string;
  url?: string;
  promptId?: string;
  templateName?: string | null;
  sizeBytes?: number | null;
  prompt?: string;
  seed?: number | null;
  // Wave P: `createdAt` comes back as a number (epoch ms) from the slim list
  // endpoint. The legacy `string` typing is kept as a union so any call site
  // still reading it as a date string keeps compiling.
  createdAt?: number | string;
  favorite?: boolean;
  // Wave F metadata — captured from ComfyUI history at execution time.
  // Every field is nullable because older rows, non-KSampler workflows,
  // and partial-detection cases produce `null` freely. Wave P moved these
  // off the list payload; only the detail endpoint (`GET /api/gallery/:id`)
  // populates them now. Tiles that don't fetch detail see `undefined`.
  workflowJson?: string | null;
  promptText?: string | null;
  negativeText?: string | null;
  model?: string | null;
  sampler?: string | null;
  steps?: number | null;
  cfg?: number | null;
  width?: number | null;
  height?: number | null;
  // Schema v4: workflow-agnostic extractor output. Populated on modern
  // (subgraph video, audio) workflows as well as classic SD.
  scheduler?: string | null;
  denoise?: number | null;
  lengthFrames?: number | null;
  fps?: number | null;
  batchSize?: number | null;
  durationMs?: number | null;
  models?: string[] | null;
}

export interface AppSettings {
  comfyuiUrl: string;
  gpuUnloadTimeout: number;
  defaultSteps: number;
  defaultCfgScale: number;
  defaultWidth: number;
  defaultHeight: number;
  galleryPath: string;
}

export interface LauncherStatus {
  running: boolean;
  uptime?: string;
  versions?: { comfyui?: string; frontend?: string; app?: string };
  gpuMode?: string;
  reachable?: boolean;
}

export interface DownloadState {
  taskId: string;
  modelName?: string;
  filename?: string;
  progress: number;
  currentModelProgress: number;
  totalBytes: number;
  downloadedBytes: number;
  speed: number;
  status: string;
  completed: boolean;
  error: string | null;
}

/** Find a live download that matches a model by filename, modelName, or either-as-the-other. */
export function findDownloadForModel(
  downloads: Record<string, DownloadState>,
  model: { name?: string; filename?: string },
): DownloadState | undefined {
  const candidates = [model.filename, model.name].filter(Boolean) as string[];
  if (candidates.length === 0) return undefined;
  for (const dl of Object.values(downloads)) {
    if (
      (dl.filename && candidates.includes(dl.filename)) ||
      (dl.modelName && candidates.includes(dl.modelName))
    ) return dl;
  }
  return undefined;
}

/** Catalog entry merged with on-disk scan state — the thing the Models page renders. */
export interface CatalogModel {
  filename: string;
  name: string;
  type: string;
  base?: string;
  save_path: string;
  description?: string;
  reference?: string;
  url: string;
  size_pretty: string;
  size_bytes: number;
  size_fetched_at: string | null;
  gated?: boolean;
  gated_message?: string;
  source: string;
  installed: boolean;
  fileSize?: number;
  fileStatus?: 'complete' | 'incomplete' | 'corrupt' | null;
  /** Preview image URL, populated at download start from card metadata. */
  thumbnail?: string;
  /** In-flight download marker — set true from download start to completion. */
  downloading?: boolean;
  /** Last download failure message (cleared when a new download starts). */
  error?: string;
}

export interface RequiredModel {
  name: string;
  directory: string;
  url: string;
  size?: number;
  size_pretty?: string;
  installed: boolean;
  gated?: boolean;
  gated_message?: string;
}

export interface DependencyCheck {
  ready: boolean;
  required: RequiredModel[];
  missing: RequiredModel[];
}

export interface AdvancedSetting {
  id: string;
  label: string;
  /**
   * Scope disclosure (node title / class, subgraph path). Rendered by the
   * UI as a tooltip next to the short `label` so users can tell where the
   * control came from without inflating the primary label text.
   */
  scopeLabel?: string;
  type: 'number' | 'slider' | 'seed' | 'select' | 'toggle' | 'text' | 'textarea';
  value: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  // `proxyIndex >= 0` = wrapper-node proxy widget (legacy path).
  // `proxyIndex === -1` = user-exposed raw-node widget, keyed by `id` of the form "node:<nodeId>:<widgetName>".
  proxyIndex: number;
}

export interface EnumeratedWidget {
  nodeId: string;
  nodeType: string;
  nodeTitle?: string;
  widgetName: string;
  label: string;
  /** Scope disclosure (subgraph + inner node). Mirrors `AdvancedSetting.scopeLabel`. */
  scopeLabel?: string;
  value: unknown;
  type: 'number' | 'slider' | 'seed' | 'select' | 'toggle' | 'text' | 'textarea';
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  exposed: boolean;
  /** True when the widget is driven by the main form (Prompt / upload field). Modal hides these. */
  formClaimed?: boolean;
  /** Subgraph name this widget lives in (present only for compound-id inner widgets). */
  scopeName?: string;
}

/* =================================================================
 * Plugin / Python / CivitAI types
 *
 * These shapes mirror the backend service types verified against
 * server/src/services/plugins/*.ts, server/src/services/python/*.ts,
 * and server/src/services/civitai/*.ts. The CivitAI shapes are
 * intentionally partial because the backend is a thin proxy to the
 * upstream CivitAI REST API; only the fields rendered by the UI are
 * typed strictly.
 * ================================================================= */

// Mirrors server's CatalogPlugin (cache.service.ts:16-48) overlayed with
// the installed-state fields from info.types.ts.
export interface Plugin {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  version: string;
  latest_version?: {
    id?: string;
    version?: string;
    changelog?: string;
    deprecated?: boolean;
    status?: string;
  } | null;
  versions?: Array<{
    id?: string;
    version?: string;
    changelog?: string;
    createdAt?: string;
    deprecated?: boolean;
    status?: string;
  }>;
  status: string;
  status_detail?: string;
  rating: number;
  downloads: number;
  github_stars: number;
  icon?: string;
  banner_url?: string;
  category?: string;
  license?: string;
  tags?: string[];
  dependencies?: string[];
  installed: boolean;
  installedOn?: string;
  disabled: boolean;
  install_type?: string;
  stars?: number;
  github?: string;
}

// Mirrors server's PluginTaskProgress (progress.service.ts:7-15).
export interface PluginTaskProgress {
  progress: number;
  completed: boolean;
  pluginId: string;
  type: 'install' | 'uninstall' | 'disable' | 'enable' | 'switch-version';
  message?: string;
  githubProxy?: string;
  logs?: string[];
}

// Mirrors server's PluginOperationHistory (history.service.ts:14-27).
export interface PluginHistoryEntry {
  id: string;
  pluginId: string;
  pluginName?: string;
  type: 'install' | 'uninstall' | 'disable' | 'enable' | 'switch-version';
  typeText?: string;
  startTime: number;
  endTime?: number;
  status: 'running' | 'success' | 'failed';
  statusText?: string;
  logs: string[];
  result?: string;
  githubProxy?: string;
}

// Mirrors server's InstalledPackage (packages.service.ts:10-13).
export interface PythonPackage {
  name: string;
  version: string;
}

// Mirrors server's DependencyItem (dependencies.service.ts:14-19).
export interface PythonDependencyItem {
  name: string;
  version: string;
  missing?: boolean;
  versionMismatch?: boolean;
}

// Mirrors server's PluginDependencyReport (dependencies.service.ts:21-25).
export interface PluginDependencyReport {
  plugin: string;
  dependencies: PythonDependencyItem[];
  missingDeps: string[];
}

// Partial of CivitAI's public Model object. Only the fields we render
// are declared strictly; the rest is dropped/ignored at runtime.
export interface CivitaiModelSummary {
  id: number;
  name: string;
  description?: string | null;
  type?: string;
  nsfw?: boolean;
  creator?: {
    username?: string;
    image?: string | null;
  };
  stats?: {
    downloadCount?: number;
    favoriteCount?: number;
    thumbsUpCount?: number;
    rating?: number;
  };
  modelVersions?: Array<{
    id: number;
    name?: string;
    baseModel?: string;
    images?: Array<{
      url?: string;
      width?: number;
      height?: number;
      type?: string;
      nsfwLevel?: number;
    }>;
    files?: Array<{
      id?: number;
      name?: string;
      sizeKB?: number;
      downloadUrl?: string;
    }>;
    downloadUrl?: string;
  }>;
  tags?: string[];
}

// Mirrors server `StagedImportManifest` (server/src/services/templates/importStaging.ts).
// Returned by POST /templates/import/upload and GET /templates/import/staging/:id.

/**
 * Manager-resolved plugin match attached to a staged workflow's
 * `plugins[].matches` array. Mirrors the backend's `PluginMapMatch` type.
 */
export interface PluginMapMatch {
  repo: string;
  title: string;
  cnr_id?: string;
}

/**
 * Per-class_type plugin resolution on a staged workflow. Zero-match rows
 * denote class types the Manager catalog doesn't recognise; the review UI
 * renders them as an unresolved warning.
 */
export interface StagedWorkflowPluginResolution {
  classType: string;
  matches: PluginMapMatch[];
}

/**
 * Per-filename resolution stamped by the Wave E "Resolve via URL"
 * affordance. Present only for missing models the user already resolved
 * in the current staging session; the UI uses it to flip a row from
 * "missing" to "resolved — click to download".
 */
export interface StagedWorkflowResolvedModel {
  downloadUrl: string;
  source: 'huggingface' | 'civitai';
  suggestedFolder?: string;
  sizeBytes?: number;
}

/**
 * Wave L auto-resolution. Populated by the staging-time auto-resolve pass
 * for filenames the server matched without user paste: catalog hit,
 * MarkdownNote URL basename match, HuggingFace search, or CivitAI search.
 * The union of `resolvedModels` + `autoResolvedModels` is what the UI
 * considers "covered" when deciding whether the Commit button is enabled.
 */
export type StagedWorkflowAutoResolveSource =
  | 'catalog' | 'markdown' | 'huggingface' | 'civitai';

export interface StagedWorkflowAutoResolvedModel {
  source: StagedWorkflowAutoResolveSource;
  downloadUrl: string;
  suggestedFolder?: string;
  sizeBytes?: number;
  confidence: 'high';
}

export interface StagedImportWorkflow {
  entryName: string;
  title: string;
  description?: string;
  nodeCount: number;
  models: string[];
  /**
   * HuggingFace / CivitAI URLs scraped from MarkdownNote / Note bodies in
   * the workflow. The review step surfaces these as one-click suggestions
   * for the "Resolve via URL" affordance.
   */
  modelUrls: string[];
  plugins: StagedWorkflowPluginResolution[];
  mediaType: 'image' | 'video' | 'audio';
  jsonBytes: number;
  /** Map of <missingFileName, resolution> populated by resolve-model calls. */
  resolvedModels?: Record<string, StagedWorkflowResolvedModel>;
  /** Wave L: staging-time auto-resolution map. */
  autoResolvedModels?: Record<string, StagedWorkflowAutoResolvedModel>;
}

/**
 * Server response for `POST /templates/:name/install-missing-plugins`.
 * `queued` entries carry a taskId the UI can poll via `/plugins/progress/:taskId`.
 */
export interface InstallMissingPluginsResult {
  queued: Array<{ pluginId: string; taskId: string }>;
  alreadyInstalled: string[];
  unknown: string[];
}

export interface StagedImportImage {
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StagedImportManifest {
  id: string;
  createdAt: number;
  source: 'upload' | 'civitai';
  sourceUrl?: string;
  workflows: StagedImportWorkflow[];
  images: StagedImportImage[];
  notes: string[];
  defaultTitle?: string;
  defaultDescription?: string;
  defaultTags?: string[];
  defaultThumbnail?: string;
  /**
   * CivitAI origin metadata. Only set for manifests produced by the CivitAI
   * URL import flow; threaded onto the committed template so the card can
   * show a source badge + tag row.
   */
  civitaiMeta?: TemplateCivitaiMeta;
}

/** Server response when a civitai import zip contains multiple workflows. */
export interface CivitaiStagedResponse {
  staged: true;
  manifest: StagedImportManifest;
}

/** Server response for the one-click civitai import (single-JSON back-compat). */
export interface CivitaiDirectResponse {
  name: string;
  imported: true;
}

// Response from GET /civitai/download/models/:versionId — CivitAI's version
// detail endpoint. Only the url/filename fields we care about.
export interface CivitaiDownloadInfo {
  id?: number;
  modelId?: number;
  name?: string;
  baseModel?: string;
  files?: Array<{
    id?: number;
    name?: string;
    sizeKB?: number;
    downloadUrl?: string;
    primary?: boolean;
    type?: string;
  }>;
  downloadUrl?: string;
  model?: { name?: string; type?: string };
}
