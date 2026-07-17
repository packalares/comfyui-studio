// Enrichment routes — split from models.routes.ts to stay under 250 lines.
//
// POST /models/enrich           — enrich one model by (save_path, filename)
// POST /models/enrich-all       — kick off the background hash queue for all
// PATCH /models/enrichment/favorite — toggle favorite on a model's sidecar

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { ValidationError } from '../lib/errors.js';
import { enrichOne } from '../services/models/enrichment/enrich.js';
import { startEnrichLoop } from '../services/models/enrichment/enrich.js';
import { readSidecar, writeSidecar } from '../services/models/enrichment/sidecar.js';
import * as modelFiles from '../lib/db/modelFiles.repo.js';
import { logger } from '../lib/logger.js';

// ---- Schemas ----

const EnrichBodySchema = z.object({
  save_path: z.string().min(1),
  filename: z.string().min(1),
  /** Which enrichment source to use. Defaults to 'auto' (CivitAI by hash). */
  source: z.enum(['auto', 'civitai']).optional(),
});

const EnrichResponseSchema = z.object({
  success: z.literal(true),
  filename: z.string(),
  metadata_source: z.string().optional(),
  trigger_words: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  nsfw_level: z.number().optional(),
  hf_repo: z.string().optional(),
});

const EnrichAllResponseSchema = z.object({
  enqueued: z.number().int().nonnegative(),
  message: z.string(),
});

const FavoriteBodySchema = z.object({
  save_path: z.string().min(1),
  filename: z.string().min(1),
  favorite: z.boolean(),
});

const FavoriteResponseSchema = z.object({
  success: z.literal(true),
  filename: z.string(),
  favorite: z.boolean(),
});

// ---- Route: POST /models/enrich ----

const enrichOneRoute = defineRoute({
  method: 'POST',
  path: '/models/enrich',
  body: EnrichBodySchema,
  response: EnrichResponseSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['models', 'enrichment'],
  summary: 'Enrich a single model from CivitAI by hash',
}, async (ctx) => {
  const { save_path, filename, source } = ctx.body;
  try {
    const meta = await enrichOne({ save_path, filename, source });
    if (!meta) throw new ValidationError(`Model not found on disk: ${filename}`);
    return ctx.ok({
      success: true as const,
      filename: meta.filename,
      metadata_source: meta.metadata_source,
      trigger_words: meta.trigger_words,
      tags: meta.tags,
      nsfw_level: meta.nsfw_level,
      hf_repo: meta.hf_repo,
    });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    logger.error('enrich route error', {
      filename,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
});

// ---- Route: POST /models/enrich-all ----

const enrichAllRoute = defineRoute({
  method: 'POST',
  path: '/models/enrich-all',
  response: EnrichAllResponseSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['models', 'enrichment'],
  summary: 'Start background SHA256 hashing queue for all un-hashed models',
}, (ctx) => {
  // startEnrichLoop iterates installed models without sidecars, calling enrichOne
  // on each (which lazily computes SHA256, looks up CivitAI then HF, writes the
  // sidecar, and fires model:enriched). Idempotent — safe to call repeatedly.
  const { enqueued } = startEnrichLoop();
  return ctx.ok({
    enqueued,
    message: enqueued > 0
      ? `Enrichment loop started — ${enqueued} models pending`
      : 'All installed models already enriched',
  });
});

// ---- Route: PATCH /models/enrichment/favorite ----
//
// Chosen as a focused PATCH rather than a full re-enrich so the client can
// toggle the star without triggering a CivitAI round-trip. The sidecar is
// read, the `favorite` field flipped, and it's written back — all user fields
// (notes, usage_tips, exclude) are preserved because we only mutate `favorite`.

const favoriteRoute = defineRoute({
  method: 'PATCH',
  path: '/models/enrichment/favorite',
  body: FavoriteBodySchema,
  response: FavoriteResponseSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['models', 'enrichment'],
  summary: 'Toggle favorite flag on a model sidecar without re-enriching',
}, (ctx) => {
  const { save_path, filename, favorite } = ctx.body;
  const rows = modelFiles.listByFilename(filename);
  const row = rows.find((r) => r.rel_path === `${save_path}/${filename}`) ?? rows[0];
  if (!row) throw new ValidationError(`Model not found in index: ${filename}`);

  const existing = readSidecar(row.abs_path) ?? {
    filename,
    save_path,
  };
  writeSidecar(row.abs_path, { ...existing, favorite });

  return ctx.ok({ success: true as const, filename, favorite });
});

// ---- Router ----

const router = Router();
enrichOneRoute.register(router);
enrichAllRoute.register(router);
favoriteRoute.register(router);

export default router;
