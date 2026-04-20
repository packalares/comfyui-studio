// Canonical resource-pack shapes.
//
// A resource pack bundles one or more model/plugin/workflow/custom downloads
// and drives the "install a recipe with one click" flow.
//
// All enums use string values so they round-trip cleanly through JSON APIs
// without `any` casts on the receiving end.

export enum ResourceType {
  MODEL = 'model',
  PLUGIN = 'plugin',
  WORKFLOW = 'workflow',
  CUSTOM = 'custom',
}

export enum InstallStatus {
  PENDING = 'pending',
  DOWNLOADING = 'downloading',
  INSTALLING = 'installing',
  COMPLETED = 'completed',
  ERROR = 'error',
  SKIPPED = 'skipped',
  CANCELED = 'canceled',
}

/** Base fields shared by all resources in a pack. */
export interface Resource {
  id: string;
  name: string;
  type: ResourceType;
  description?: string;
  /** File size in bytes, when known. */
  size?: number;
  /** Whether the resource can be skipped without breaking the pack. */
  optional?: boolean;
}

/** URL shape supporting multiple download sources. */
export interface ResourceUrl {
  hf?: string;
  mirror?: string;
  cdn?: string;
}

export interface ModelResource extends Resource {
  type: ResourceType.MODEL;
  url: string | ResourceUrl;
  /** Path relative to ComfyUI's `models/` directory. */
  dir: string;
  /** Output filename on disk. */
  out: string;
  essential?: boolean;
}

export interface PluginResource extends Resource {
  type: ResourceType.PLUGIN;
  github: string;
  branch?: string;
}

export interface WorkflowResource extends Resource {
  type: ResourceType.WORKFLOW;
  url: string | ResourceUrl;
  filename: string;
}

export interface CustomResource extends Resource {
  type: ResourceType.CUSTOM;
  url: string | ResourceUrl;
  /** Absolute destination on disk (subject to `safeResolve` at write time). */
  destination: string;
}

export type PackResource =
  | ModelResource
  | PluginResource
  | WorkflowResource
  | CustomResource;

export interface ResourcePack {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  tags?: string[];
  resources: PackResource[];
}

/** Per-resource install state, reported in a pack-install progress snapshot. */
export interface ResourceInstallStatus {
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  status: InstallStatus;
  progress: number;
  error?: string;
  startTime?: number;
  endTime?: number;
}

/** Aggregate install progress for a whole resource pack. */
export interface ResourcePackInstallProgress {
  packId: string;
  packName: string;
  taskId: string;
  status: InstallStatus;
  currentResourceIndex: number;
  totalResources: number;
  /** 0-100 overall progress. */
  progress: number;
  startTime: number;
  endTime?: number;
  resourceStatuses: ResourceInstallStatus[];
  error?: string;
  canceled?: boolean;
}

/** Options accepted by the custom-download installer. */
export interface CustomDownloadOptions {
  abortController: AbortController;
  onProgress: (progress: number, downloadedBytes: number, totalBytes: number) => void;
}
