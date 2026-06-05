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

export const MergedModelSchema = CatalogModelSchema.extend({
  installed: z.boolean(),
  fileSize: z.number().optional(),
  fileStatus: z.enum(['complete', 'incomplete', 'corrupt']).nullable().optional(),
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
