// CivitAI by-hash lookup routes.
// Split from civitai.routes.ts (already at cap) to stay within line budget.
//
// GET  /civitai/models/by-hash/:sha256 — single hash lookup
// POST /civitai/models/by-hash         — batch lookup (body: string[])

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { HttpError, ValidationError } from '../lib/errors.js';
import { civitaiSource } from '../services/models/enrichment/CivitaiModelSource.js';

// ---- Schemas ----

const ByHashParamsSchema = z.object({
  sha256: z.string().min(64).max(64).regex(/^[0-9a-fA-F]+$/, 'sha256 must be 64 hex chars'),
});

const ByHashResultSchema = z.object({
  metadata_source: z.enum(['civitai', 'huggingface']),
  civitai_version_id: z.number().int().optional(),
  civitai_model_id: z.number().int().optional(),
  model_name: z.string().optional(),
  base_model: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  trigger_words: z.array(z.string()).optional(),
  nsfw_level: z.number().int().optional(),
  preview_remote_url: z.string().optional(),
}).passthrough();

const ByHashBatchBodySchema = z.object({
  hashes: z.array(z.string().min(64).max(64)).min(1).max(100),
});

const ByHashBatchResponseSchema = z.record(z.string(), ByHashResultSchema.nullable());

// ---- Routes ----

const byHashSingleRoute = defineRoute({
  method: 'GET',
  path: '/civitai/models/by-hash/:sha256',
  params: ByHashParamsSchema,
  response: z.unknown(),
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Look up a CivitAI model version by SHA256 hash',
}, async (ctx) => {
  const { sha256 } = ctx.params;
  try {
    const result = await civitaiSource.searchByHash(sha256.toLowerCase());
    return ctx.ok(result as unknown as Record<string, unknown>);
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

const byHashBatchRoute = defineRoute({
  method: 'POST',
  path: '/civitai/models/by-hash',
  body: ByHashBatchBodySchema,
  response: z.unknown(),
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['civitai'],
  summary: 'Batch look up CivitAI model versions by SHA256 hashes (max 100)',
}, async (ctx) => {
  const { hashes } = ctx.body;
  if (hashes.length > 100) {
    throw new ValidationError('Maximum 100 hashes per batch request');
  }
  try {
    const map = await civitaiSource.searchByHashBatch(hashes.map((h) => h.toLowerCase()));
    // Convert Map to plain object keyed by hash.
    const result: Record<string, unknown> = {};
    for (const hash of hashes) {
      result[hash.toLowerCase()] = map.get(hash.toLowerCase()) ?? null;
    }
    return ctx.ok(result as unknown as Record<string, unknown>);
  } catch {
    throw new HttpError('upstream_unavailable', 'Civitai request failed');
  }
});

// ---- Router ----
// Note: literal POST /by-hash must be registered BEFORE parameterised GET /:sha256
// to prevent Express matching "by-hash" as a sha256 param (won't match anyway
// since it's GET vs POST, but ordering stays explicit).

const router = Router();
byHashBatchRoute.register(router);
byHashSingleRoute.register(router);

export default router;
