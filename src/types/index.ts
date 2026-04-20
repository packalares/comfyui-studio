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
}

export type StudioCategory = 'image' | 'video' | 'audio' | '3d' | 'tools';

export interface Template {
  name: string;
  title: string;
  description: string;
  mediaType: string;
  tags: string[];
  models: string[];
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
}

export interface TemplateCategory {
  name: string;
  isEssential?: boolean;
  templates: Template[];
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
  templateName?: string;
  prompt?: string;
  seed?: number;
  createdAt?: string;
  favorite?: boolean;
}

export interface ModelInfo {
  name: string;
  type: string;
  size: number;
  path: string;
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

export interface ProgressUpdate {
  type: 'progress' | 'executing' | 'executed' | 'execution_complete' | 'error';
  data: {
    value?: number;
    max?: number;
    node?: string;
    prompt_id?: string;
    output?: Record<string, unknown>;
    exception_message?: string;
  };
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
}

export interface LauncherModel {
  name: string;
  type: string;
  filename: string;
  url: string;
  size?: string;
  fileSize?: number;
  installed: boolean;
  save_path?: string;
  description?: string;
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
  value: unknown;
  type: 'number' | 'slider' | 'seed' | 'select' | 'toggle' | 'text' | 'textarea';
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
  exposed: boolean;
  /** True when the widget is driven by the main form (Prompt / upload field). Modal hides these. */
  formClaimed?: boolean;
}
