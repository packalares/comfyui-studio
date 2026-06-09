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
  type: 'text' | 'textarea' | 'image' | 'audio' | 'video' | 'number' | 'slider' | 'select' | 'toggle'
    | 'mode-select' | 'bypass-toggle';
  required: boolean;
  description?: string;
  placeholder?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  /**
   * options is used by 'select' and 'mode-select'. Mode-select options
   * also carry bypassNodes so the submit payload can convey which subgraph
   * nodes to mute when that option is chosen (handled server-side).
   */
  options?: Array<{ label: string; value: string; bypassNodes?: number[] }>;
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
  /**
   * Present on regular form fields when a mode-select field exists on the
   * same form. Identifies which mode value(s) this field belongs to.
   * undefined → always visible. A string or string[] → hide when the
   * selected mode doesn't match.
   */
  modeRequired?: string | string[];
  /**
   * Present on image upload fields when the server detected at least one
   * inpaint/outpaint pattern downstream of the LoadImage node. Each entry
   * is one available mask UI kind, optionally tagged with the mode-select
   * value that must be active for it to apply:
   *   - one entry, no `requiresMode`  → single-pipeline template; that kind
   *     is always shown.
   *   - multiple entries with distinct `requiresMode` values → multi-pipeline
   *     template (e.g. OneReward inpaint + outpaint). The UI picks the
   *     entry matching the active mode-select value and swaps the modal
   *     between brush and pad as the user toggles modes.
   *   'brush' → show a brush-paint mask canvas.
   *   'pad'   → show a drag-edges pad picker.
   */
  maskable?: Array<{ kind: 'brush' | 'pad'; requiresMode?: string }>;
  /**
   * Flat id of the ImagePadForOutpaint node when maskable === 'pad'.
   * Included in the submit payload so the server can write pad values onto
   * the correct node before executing the prompt.
   */
  padTargetNodeId?: string;
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

/** Slim wire shape returned by `/api/templates/list`. Used in AppContext +
 *  picker dropdowns + Models/Explore aggregations. Audited consumers read
 *  ONLY these 8 fields — anything else (description, thumbnails, civitai
 *  meta, etc.) lives on the full `Template` and ships via
 *  `/api/template-bundle/:name` on demand or via the paginated
 *  `/api/templates?page=…` for the Explore grid. Add fields back here only
 *  when a real consumer appears. */
export interface TemplateSummary {
  name: string;
  title: string;
  category: string;
  studioCategory?: StudioCategory;
  mediaType: string;
  tags: string[];
  /** First-required-model badge shown by ModelDropdown + the search corpus. */
  models: string[];
  openSource?: boolean;
  /** 0 unknown / 1 comfy-catalog / 2 civitai / 3 github / 4 upload. Enables
   *  client-side aggregation that respects the active source filter (tag
   *  chips + category counts only reflect the visible subset). */
  source_type?: number;
  favorite?: boolean;
  /** Tags this template as a curated builder for the Image/Video/Audio
   *  Easy-mode UIs in Studio. Set in the TemplateData JSON. */
  studioBuilder?: 'image' | 'video' | 'audio';
  /** Display label for the model dropdown in the Easy-mode UI. */
  modelDisplayName?: string;
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
   * True when the user has pinned this template via the star on the Explore
   * card. Backed by the `templates.favorite` column; `undefined`/`false` when
   * unpinned or unknown. Toggle via PATCH /templates/:name/favorite.
   */
  favorite?: boolean;
  /**
   * CivitAI origin metadata. Only populated for user-imported templates
   * that came in through the CivitAI URL tab.
   */
  civitaiMeta?: TemplateCivitaiMeta;
}

// Re-exported from server contract (single source of truth).
export type { QueueStatus } from '@server/contracts/system.contract';

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

// Re-exported from server contracts (single source of truth).
export type { GalleryItem, WorkflowDetail } from '@server/contracts/gallery.contract';

export interface AppSettings {
  comfyuiUrl: string;
  gpuUnloadTimeout: number;
  defaultSteps: number;
  defaultCfgScale: number;
  defaultWidth: number;
  defaultHeight: number;
  galleryPath: string;
}

/** Launcher status as seen by the UI (richer than the server's index-signature version). */
export interface LauncherStatus {
  running: boolean;
  uptime?: string;
  versions?: { comfyui?: string; frontend?: string; app?: string };
  gpuMode?: string;
  reachable?: boolean;
}

// Re-exported from server contracts (single source of truth).
import type { DownloadState } from '@server/contracts/system.contract';
export type { DownloadState };

/** Find a live download that matches a model. Prefers modelName match — bare
 *  filename collides when multiple catalog rows share a basename (e.g. the
 *  multi-file HF models ACE-Step transcriber + captioner both ship
 *  `model-00001-of-00005.safetensors`). Falls back to filename only when the
 *  row has no name (legacy / uncatalogued disk entry). */
export function findDownloadForModel(
  downloads: Record<string, DownloadState>,
  model: { name?: string; filename?: string },
): DownloadState | undefined {
  if (model.name) {
    for (const dl of Object.values(downloads)) {
      if (dl.modelName === model.name) return dl;
    }
    return undefined;
  }
  if (model.filename) {
    for (const dl of Object.values(downloads)) {
      if (dl.filename === model.filename || dl.modelName === model.filename) return dl;
    }
  }
  return undefined;
}

/** One node entry inside a workflow group (from the template bundle). */
export interface WorkflowGroupNode {
  id: string;
  classType: string;
  title: string;
}

/** A litegraph group with its member nodes (positional assignment, server-computed). */
export interface WorkflowGroup {
  id: number;
  title: string;
  color?: string;
  nodes: WorkflowGroupNode[];
}

// Re-exported from server contracts (single source of truth).
export type { UrlHost, UrlSource } from '@server/contracts/catalog.contract';

// Re-exported from server contracts: MergedModel = CatalogModel + installed/fileSize/fileStatus.
export type { MergedModel as CatalogModel } from '@server/contracts/catalog.contract';

export interface RequiredModel {
  /** Discriminator for the union with `RequiredPlugin`. Optional for back-
   *  compat with payloads pre-redesign — undefined means model. */
  kind?: 'model';
  name: string;
  directory: string;
  url: string;
  /**
   * HuggingFace repo id (e.g. `IndexTeam/IndexTTS-2`). Present instead of
   * `url` for whole-repo entries (custom-node registry). DependencyModal
   * routes those through `api.downloadHfRepo` instead of the single-URL
   * `downloadCustomModel` path.
   */
  hfRepo?: string;
  size?: number;
  size_pretty?: string;
  installed: boolean;
  gated?: boolean;
  gated_message?: string;
}

/** Per-class-type plugin entry returned by `/api/check-dependencies` for
 *  workflow nodes whose owning custom-node plugin isn't installed. The
 *  `repos` list carries every candidate plugin URL Manager / aux-ids
 *  identified — typically one, occasionally more. */
export interface RequiredPlugin {
  kind: 'plugin';
  /** Workflow node class_type (e.g. `DrawViTPose`). */
  classType: string;
  /** Subgraph name the class lives in, or null when at top level. */
  subgraphName: string | null;
  repos: Array<{ repo: string; title: string; cnr_id?: string }>;
  installed: boolean;
}

export type RequiredItem = RequiredModel | RequiredPlugin;

/** Type-narrowing helper used by the dependency modal to split a mixed
 *  list into its model + plugin subsets without losing typings. */
export function isRequiredPlugin(x: RequiredItem): x is RequiredPlugin {
  return x.kind === 'plugin';
}

export interface DependencyCheck {
  ready: boolean;
  required: RequiredItem[];
  missing: RequiredItem[];
}

// Re-exported from server contracts (single source of truth).
export type { AdvancedSetting } from '@server/contracts/workflow.contract';

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
  /**
   * True when the widget is driven by the main form (Prompt / upload field).
   * The modal renders these as checked + read-only so the user sees that
   * the row is in Advanced (the main form put it there) without being able
   * to toggle it off.
   */
  formClaimed?: boolean;
  /**
   * True when the widget is exposed via a wrapper subgraph's `proxyWidgets`
   * list (the workflow author's curated Advanced Settings). Same UX as
   * `formClaimed`: checked + read-only in the modal.
   */
  proxyExposed?: boolean;
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

export interface DashboardSummary {
  modelsInstalled: number | null;
  pluginsInstalled: number | null;
  pluginHistory: PluginHistoryEntry[];
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
  | 'catalog' | 'markdown' | 'huggingface' | 'civitai' | 'hfRepo';

export interface StagedWorkflowAutoResolvedModel {
  source: StagedWorkflowAutoResolveSource;
  /** Empty string for `source: 'hfRepo'` — the whole repo is the artifact. */
  downloadUrl: string;
  /** HuggingFace repo id for whole-repo downloads (e.g. `IndexTeam/IndexTTS-2`). */
  hfRepo?: string;
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
