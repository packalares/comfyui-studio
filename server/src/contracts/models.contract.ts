// Canonical model-related shapes.
//
// The studio already defines `LauncherModelEntry` and related types in
// `generation.contract.ts`. Keep those as the canonical scan / catalog
// contracts and add here only the download/progress shapes plus the
// essential-model metadata that the launcher's controllers return.

import { z } from 'zod';

export const ModelSourceUrlsSchema = z.object({
  hf: z.string().optional(),
  mirror: z.string().optional(),
  cdn: z.string().optional(),
});
export type ModelSourceUrls = z.infer<typeof ModelSourceUrlsSchema>;

export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  dir: z.string(),
  out: z.string(),
  url: ModelSourceUrlsSchema,
  description: z.string().optional(),
  essential: z.boolean().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const EssentialModelSchema = ModelInfoSchema.omit({ url: true }).extend({
  url: z.object({ hf: z.string(), mirror: z.string() }),
  size: z.string().optional(),
  essential: z.literal(true),
});
export type EssentialModel = z.infer<typeof EssentialModelSchema>;

export type DownloadStatus = 'downloading' | 'completed' | 'error' | 'canceled';

// `DownloadProgress` is used at runtime (service layer) with `abortController`;
// the Zod schema covers only the wire-safe fields (no AbortController on the wire).
export interface DownloadProgress {
  currentModel: EssentialModel | null;
  currentModelIndex: number;
  overallProgress: number;
  currentModelProgress: number;
  completed: boolean;
  error: string | null;
  downloadedBytes: number;
  totalBytes: number;
  speed: number;
  status: DownloadStatus;
  startTime?: number;
  lastUpdateTime?: number;
  lastBytes?: number;
  abortController?: AbortController;
  canceled?: boolean;
  cancelTime?: number;
  startBytes?: number;
  lastLogTime?: number;
}

/** Wire shape for a completed scan entry. */
export const LauncherCompatEntrySchema = z.object({
  filename: z.string().optional(),
  name: z.string().optional(),
  save_path: z.string(),
  type: z.string().optional(),
  fileSize: z.number().optional(),
  installed: z.boolean().optional(),
  url: z.string().optional(),
  base: z.string().optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
  fileStatus: z.enum(['complete', 'incomplete', 'corrupted', 'unknown']).optional(),
  size: z.string().optional(),
});
export type LauncherCompatEntry = z.infer<typeof LauncherCompatEntrySchema>;

export const ScanResultSchema = z.object({
  success: z.literal(true),
  count: z.number().int().nonnegative(),
  models: z.array(LauncherCompatEntrySchema),
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

export const RescanResultSchema = z.object({
  added: z.number().int(),
  removed: z.number().int(),
  total: z.number().int(),
  modelListRefreshed: z.boolean(),
});
export type RescanResult = z.infer<typeof RescanResultSchema>;

export const DownloadHistoryItemSchema = z.object({
  id: z.string(),
  modelName: z.string(),
  status: z.enum(['success', 'failed', 'canceled', 'downloading']),
  statusText: z.string().optional(),
  startTime: z.number(),
  endTime: z.number().optional(),
  fileSize: z.number().optional(),
  downloadedSize: z.number().optional(),
  error: z.string().optional(),
  source: z.string().optional(),
  speed: z.number().optional(),
  downloadUrl: z.string().optional(),
  taskId: z.string().optional(),
  progress: z.number().optional(),
});
export type DownloadHistoryItem = z.infer<typeof DownloadHistoryItemSchema>;

export const InstallResultSchema = z.object({
  success: z.literal(true),
  taskId: z.string(),
  message: z.string().optional(),
  alreadyActive: z.boolean().optional(),
});
export type InstallResult = z.infer<typeof InstallResultSchema>;

export const DownloadCustomResultSchema = z.object({
  success: z.literal(true),
  taskId: z.string(),
  message: z.string().optional(),
  alreadyActive: z.boolean().optional(),
  queued: z.boolean().optional(),
});
export type DownloadCustomResult = z.infer<typeof DownloadCustomResultSchema>;

export const DownloadHfRepoResultSchema = z.object({
  success: z.literal(true),
  taskId: z.string(),
  modelName: z.string(),
});
export type DownloadHfRepoResult = z.infer<typeof DownloadHfRepoResultSchema>;

export const CancelResultSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});
export type CancelResult = z.infer<typeof CancelResultSchema>;

export const DeleteModelResultSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});
export type DeleteModelResult = z.infer<typeof DeleteModelResultSchema>;

export const HistoryClearResultSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const HistoryDeleteResultSchema = z.object({
  success: z.literal(true),
  message: z.string(),
});

export const DiscoverHfReposDrySchema = z.object({
  success: z.literal(true),
  found: z.array(z.object({
    dir: z.string(),
    relDir: z.string(),
    hfRepo: z.string().nullable(),
    representativeFile: z.string().nullable(),
    hfRepoSource: z.enum(['config._name_or_path', 'cache', 'readme']).nullable(),
  })),
});

export const DiscoverHfReposMutateSchema = z.object({
  success: z.literal(true),
  scanned: z.number().int(),
  upserted: z.number().int(),
  skippedNoRepo: z.number().int(),
  skippedNoFile: z.number().int(),
  entries: z.array(z.object({
    relDir: z.string(),
    hfRepo: z.string(),
    filename: z.string(),
  })),
});

export const DownloadCustomBodySchema = z.object({
  modelName: z.string().optional(),
  filename: z.string().optional(),
  hfUrl: z.string().optional(),
  modelDir: z.string().optional(),
  hfToken: z.string().optional(),
  civitaiToken: z.string().optional(),
  githubToken: z.string().optional(),
  meta: z.object({
    type: z.string().optional(),
    description: z.string().optional(),
    reference: z.string().optional(),
    size_bytes: z.number().optional(),
    thumbnail: z.string().optional(),
    gated: z.boolean().optional(),
    source: z.string().optional(),
  }).optional(),
});
export type DownloadCustomBody = z.infer<typeof DownloadCustomBodySchema>;

export const DownloadHfRepoBodySchema = z.object({
  hfRepo: z.string().min(1),
  directory: z.string().min(1),
  name: z.string().optional(),
  hfToken: z.string().optional(),
});
export type DownloadHfRepoBody = z.infer<typeof DownloadHfRepoBodySchema>;

/** Options accepted by the core downloader. Not a wire shape; kept for typing. */
export interface DownloadOptions {
  abortController: AbortController;
  onProgress: (progress: DownloadProgress) => void;
  source?: string;
  basePath?: string;
  authHeaders?: Record<string, string>;
}

// ---- Local sub-schemas (moved from routes/models.routes.ts) ----

/** Polymorphic delete identifier. The route tries the keys in this order:
 *    1. `abs_path` — canonical local identifier; can never collide.
 *    2. `sha256` — unique by content. Resolves to the row's abs_path.
 *    3. `(save_path, filename)` pair — natural composite key on model_files.
 *    4. `modelName` — legacy display-name lookup; kept for backward compat.
 *  Allowing all four keeps the wire flexible: the UI already has the pair
 *  on every catalog row and sends it; older clients fall back gracefully. */
export const DeleteBodySchema = z.object({
  abs_path: z.string().min(1).optional(),
  sha256: z.string().length(64).optional(),
  save_path: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
}).refine(
  (b) => !!(b.abs_path || b.sha256 || (b.save_path && b.filename) || b.modelName),
  { message: 'Must supply abs_path, sha256, (save_path, filename) pair, or modelName' },
);

export const CancelBodySchema = z.object({
  taskId: z.string().optional(),
  modelName: z.string().optional(),
}).refine((b: { taskId?: string; modelName?: string }) => b.taskId !== undefined || b.modelName !== undefined, {
  message: 'taskId or modelName required',
});

const InstallBodySchema = z.object({ source: z.string().optional() });
const InstallParamsSchema = z.object({ modelName: z.string().min(1) });

const HistoryQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

const HistoryDeleteBodySchema = z.object({ id: z.string().min(1) });

// ---- Route specs — exported here so the UI client can import them
// without dragging Express/multer/services into the browser bundle. ----

export const TypeMapResponseSchema = z.object({
  types: z.record(z.string(), z.string()),
  civitaiTypes: z.record(z.string(), z.string()),
});
export type TypeMapResponse = z.infer<typeof TypeMapResponseSchema>;

export const modelsRoutes = {
  typeMap: {
    method: 'GET' as const,
    path: '/models/type-map',
    response: TypeMapResponseSchema,
    auth: { required: true, scopes: ['catalog:read'] as const },
    tags: ['models'],
    summary: 'Catalog-type → ComfyUI subdir map (shared by UI and server)',
  },
  folders: {
    method: 'GET' as const,
    path: '/models/folders',
    response: z.array(z.string()),
    auth: { required: true, scopes: ['models:read'] as const },
    tags: ['models'],
    summary: 'List registered ComfyUI model folders',
  },
  scan: {
    method: 'POST' as const,
    path: '/models/scan',
    response: ScanResultSchema,
    auth: { required: true, scopes: ['models:write'] as const },
    tags: ['models'],
    summary: 'Scan on-disk models and refresh catalog',
  },
  rescan: {
    method: 'POST' as const,
    path: '/models/rescan',
    response: RescanResultSchema,
    auth: { required: true, scopes: ['models:write'] as const },
    tags: ['models'],
    summary: 'Rebuild model index from upstream + disk',
  },
  deleteModel: {
    method: 'POST' as const,
    path: '/models/delete',
    body: DeleteBodySchema,
    response: DeleteModelResultSchema,
    auth: { required: true, scopes: ['models:write'] as const },
    tags: ['models'],
    summary: 'Delete a model from disk',
  },
  cancelDownload: {
    method: 'POST' as const,
    path: '/models/cancel-download',
    body: CancelBodySchema,
    response: CancelResultSchema,
    auth: { required: true, scopes: ['models:write'] as const },
    tags: ['models'],
    summary: 'Cancel an active download by taskId or modelName',
  },
  install: {
    method: 'POST' as const,
    path: '/models/install/:modelName',
    params: InstallParamsSchema,
    body: InstallBodySchema,
    response: InstallResultSchema,
    auth: { required: true, scopes: ['models:install'] as const },
    tags: ['models'],
    summary: 'Start a catalog model install by name',
  },
  downloadHistory: {
    method: 'GET' as const,
    path: '/models/download-history',
    query: HistoryQuerySchema,
    response: z.array(DownloadHistoryItemSchema),
    auth: { required: true, scopes: ['models:read'] as const },
    tags: ['models'],
    summary: 'Paginated download history, newest first',
  },
  downloadHistoryClear: {
    method: 'POST' as const,
    path: '/models/download-history/clear',
    response: HistoryClearResultSchema,
    auth: { required: true, scopes: ['models:write'] as const },
    tags: ['models'],
    summary: 'Clear all download history',
  },
  downloadHistoryDelete: {
    method: 'POST' as const,
    path: '/models/download-history/delete',
    body: HistoryDeleteBodySchema,
    response: HistoryDeleteResultSchema,
    auth: { required: true, scopes: ['models:write'] as const },
    tags: ['models'],
    summary: 'Delete a single history entry by id',
  },
  downloadCustom: {
    method: 'POST' as const,
    path: '/models/download-custom',
    body: DownloadCustomBodySchema,
    response: DownloadCustomResultSchema,
    auth: { required: true, scopes: ['models:install'] as const },
    tags: ['models'],
    summary: 'Kick off a download from a URL (HF / CivitAI / GitHub)',
  },
  downloadHfRepo: {
    method: 'POST' as const,
    path: '/models/download-hf-repo',
    body: DownloadHfRepoBodySchema,
    response: DownloadHfRepoResultSchema,
    auth: { required: true, scopes: ['models:install'] as const },
    tags: ['models'],
    summary: 'Download an entire HuggingFace repo snapshot',
  },
  discoverHfReposGet: {
    method: 'GET' as const,
    path: '/models/discover-hf-repos',
    response: DiscoverHfReposDrySchema,
    auth: { required: true, scopes: ['models:read'] as const },
    tags: ['models'],
    summary: 'Dry-run: discover HuggingFace snapshot dirs without mutating catalog',
  },
  discoverHfReposPost: {
    method: 'POST' as const,
    path: '/models/discover-hf-repos',
    response: DiscoverHfReposMutateSchema,
    auth: { required: true, scopes: ['models:write'] as const },
    tags: ['models'],
    summary: 'Discover HuggingFace snapshot dirs and upsert into catalog',
  },
  usedBy: {
    method: 'GET' as const,
    path: '/models/used-by',
    query: z.object({ filename: z.string().min(1) }),
    response: z.array(z.string()),
    auth: { required: true, scopes: ['catalog:read'] as const },
    tags: ['models'],
    summary: 'Templates whose workflow references this model basename',
  },
} as const;
