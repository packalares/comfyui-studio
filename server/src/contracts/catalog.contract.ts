// Canonical shapes for the model catalog. Services and routes import from
// here; no other file should re-declare these interfaces.

import { z } from 'zod';

export type FileStatus = 'complete' | 'incomplete' | 'corrupt' | null;
export type UrlHost = 'hf' | 'civitai' | 'github' | 'generic';

export const UrlHostSchema = z.enum(['hf', 'civitai', 'github', 'generic']);

export const UrlSourceSchema = z.object({
  url: z.string(),
  host: UrlHostSchema,
  /** Discovery context: 'seed' | 'template:<name>' | 'user' | 'manual' | 'scan'. */
  declaredBy: z.string(),
});
export type UrlSource = z.infer<typeof UrlSourceSchema>;

export const CatalogModelSchema = z.object({
  filename: z.string(),
  name: z.string(),
  type: z.string(),
  base: z.string().optional(),
  save_path: z.string(),
  description: z.string().optional(),
  reference: z.string().optional(),
  url: z.string(),
  urlSources: z.array(UrlSourceSchema).optional(),
  size_pretty: z.string(),
  size_bytes: z.number(),
  size_fetched_at: z.string().nullable(),
  gated: z.boolean().optional(),
  gated_message: z.string().optional(),
  source: z.string(),
  thumbnail: z.string().optional(),
  downloading: z.boolean().optional(),
  error: z.string().optional(),
  hfRepo: z.string().optional(),
  pendingNodeInstall: z.boolean().optional(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

// Optional enrichment fields surfaced from `.metadata.json` sidecars.
// Added as a wire-only overlay — not stored in catalog.json.
export const CatalogEnrichmentSchema = z.object({
  tags: z.array(z.string()).optional(),
  trigger_words: z.array(z.string()).optional(),
  nsfw_level: z.number().int().optional(),
  favorite: z.boolean().optional(),
  // Server may emit null when a sidecar exists but hasn't been enriched yet
  // (e.g. background hash-queue computed sha256 but CivitAI/HF lookup didn't
  // resolve). Accept null so the envelope passes; UI treats null as "unknown".
  metadata_source: z.string().nullable().optional(),
  civitai_model_id: z.number().int().nullable().optional(),
  civitai_version_id: z.number().int().nullable().optional(),
  /** Full model description (HTML allowed) from CivitAI's /models/{id} call.
   *  Persisted in our sidecar but not in CLM's — we fetch it via the
   *  follow-up /api/v1/models/{id} request because by-hash strips it. */
  description: z.string().nullable().optional(),
  preview_remote_url: z.string().nullable().optional(),
  /** Relative filename of the local `.preview.webp` next to the model file.
   *  When present, UI is safe to GET /models/preview/<save_path>/<filename>
   *  without producing a 404. When absent, UI must skip the local preview
   *  fetch and go straight to remote thumbnail. */
  preview_local_path: z.string().nullable().optional(),
  base_model: z.string().nullable().optional(),
  hf_repo: z.string().nullable().optional(),
  urlSources_verified: z.array(z.object({
    url: z.string(),
    host: z.string(),
    declaredBy: z.string().optional(),
    sha256: z.string().nullable().optional(),
    status: z.enum(['ok', 'mismatch', 'unknown', 'error']),
    error: z.string().nullable().optional(),
  })).optional(),
}).optional();
export type CatalogEnrichment = z.infer<typeof CatalogEnrichmentSchema>;

export const MergedModelSchema = CatalogModelSchema.extend({
  installed: z.boolean(),
  fileSize: z.number().optional(),
  fileStatus: z.enum(['complete', 'incomplete', 'corrupt']).nullable().optional(),
  /** Sidecar-sourced enrichment fields — present only when a sidecar exists. */
  enrichment: CatalogEnrichmentSchema,
});
export type MergedModel = z.infer<typeof MergedModelSchema>;

export const CatalogStatsSchema = z.object({
  installedCount: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  totalDiskSize: z.number().int().nonnegative(),
  types: z.array(z.string()),
});
export type CatalogStats = z.infer<typeof CatalogStatsSchema>;

// Route specs — exported here (not from routes/) so the UI client can import
// them without dragging Express/multer into the browser bundle.

const CatalogListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
  q: z.string().optional(),
  type: z.string().optional(),
  installed: z.enum(['true', 'false']).optional(),
  /** Comma-separated basenames; only catalog rows whose `filename` is in
   *  this set are returned. Used by the Models page to narrow the grid to
   *  just the models required by the user-picked template. */
  filenames: z.string().optional(),
});

export const catalogRoutes = {
  list: {
    method: 'GET' as const,
    path: '/models/catalog',
    query: CatalogListQuerySchema,
    response: z.array(MergedModelSchema),
    auth: { required: true, scopes: ['catalog:read'] as const },
    tags: ['catalog'],
    summary: 'Merged catalog + disk scan view',
  },
  stats: {
    method: 'GET' as const,
    path: '/models/stats',
    response: CatalogStatsSchema,
    auth: { required: true, scopes: ['catalog:read'] as const },
    tags: ['catalog'],
    summary: 'Installed count, disk usage, and distinct types',
  },
} as const;
