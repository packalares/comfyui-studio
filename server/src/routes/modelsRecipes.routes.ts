// CRUD routes for the Recipe system.
// Recipes are named LoRA combinations stored in SQLite.
// Workflow injection is out of scope — these routes are CRUD only.
//
// GET  /models/recipes            — list (query: search, tag)
// GET  /models/recipes/:id        — get one, 404 if missing
// POST /models/recipes            — create
// PATCH /models/recipes/:id       — partial update
// DELETE /models/recipes/:id      — delete, 404 if missing
// GET  /models/recipes/:id/export — JSON download
// POST /models/recipes/import     — JSON body upload

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { normalizeModelFilename } from '../services/models/identity.js';
import * as recipes from '../services/models/recipes/index.js';

// ---- Zod schemas ----

const LoraEntrySchema = z.object({
  filename: z.string().min(1),
  save_path: z.string().min(0),
  strength: z.number(),
});

const RecipeSchema = z.object({
  id: z.number(),
  title: z.string(),
  notes: z.string().optional(),
  tags: z.array(z.string()),
  loras: z.array(LoraEntrySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const NewRecipeBodySchema = z.object({
  title: z.string().min(1),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  loras: z.array(LoraEntrySchema).min(1),
});

const PatchRecipeBodySchema = z.object({
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional(),
  loras: z.array(LoraEntrySchema).min(1).optional(),
});

const IdParamSchema = z.object({ id: z.string() });

const ListQuerySchema = z.object({
  search: z.string().optional(),
  tag: z.string().optional(),
});

// ---- Helpers ----

function parseId(raw: string): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) throw new ValidationError(`Invalid recipe id: ${raw}`);
  return n;
}

function normalizeLoras(loras: Array<{ filename: string; save_path: string; strength: number }>) {
  return loras.map((l) => ({
    ...l,
    filename: normalizeModelFilename(l.filename),
  }));
}

// ---- GET /models/recipes ----

const listRoute = defineRoute({
  method: 'GET',
  path: '/models/recipes',
  query: ListQuerySchema,
  response: z.array(RecipeSchema),
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['models', 'recipes'],
  summary: 'List saved LoRA recipes',
}, (ctx) => {
  const items = recipes.list({ search: ctx.query.search, tag: ctx.query.tag });
  return ctx.ok(items);
});

// ---- GET /models/recipes/:id ----

const getOneRoute = defineRoute({
  method: 'GET',
  path: '/models/recipes/:id',
  params: IdParamSchema,
  response: RecipeSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['models', 'recipes'],
  summary: 'Get a single recipe by id',
}, (ctx) => {
  const id = parseId(ctx.params.id);
  const recipe = recipes.get(id);
  if (!recipe) throw new NotFoundError(`Recipe ${id} not found`);
  return ctx.ok(recipe);
});

// ---- POST /models/recipes ----

const createRoute = defineRoute({
  method: 'POST',
  path: '/models/recipes',
  body: NewRecipeBodySchema,
  response: RecipeSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['models', 'recipes'],
  summary: 'Create a new recipe',
}, (ctx) => {
  const { title, notes, tags = [], loras } = ctx.body;
  const created = recipes.create({
    title,
    notes,
    tags,
    loras: normalizeLoras(loras),
  });
  return ctx.ok(created);
});

// ---- PATCH /models/recipes/:id ----

const patchRoute = defineRoute({
  method: 'PATCH',
  path: '/models/recipes/:id',
  params: IdParamSchema,
  body: PatchRecipeBodySchema,
  response: RecipeSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['models', 'recipes'],
  summary: 'Partially update a recipe',
}, (ctx) => {
  const id = parseId(ctx.params.id);
  const patch = {
    ...ctx.body,
    loras: ctx.body.loras ? normalizeLoras(ctx.body.loras) : undefined,
  };
  const updated = recipes.update(id, patch);
  if (!updated) throw new NotFoundError(`Recipe ${id} not found`);
  return ctx.ok(updated);
});

// ---- DELETE /models/recipes/:id ----

const deleteRoute = defineRoute({
  method: 'DELETE',
  path: '/models/recipes/:id',
  params: IdParamSchema,
  response: z.object({ deleted: z.literal(true), id: z.number() }),
  auth: { required: true, scopes: ['models:write'] },
  tags: ['models', 'recipes'],
  summary: 'Delete a recipe',
}, (ctx) => {
  const id = parseId(ctx.params.id);
  const ok = recipes.remove(id);
  if (!ok) throw new NotFoundError(`Recipe ${id} not found`);
  return ctx.ok({ deleted: true as const, id });
});

// ---- GET /models/recipes/:id/export ----

const router = Router();

// Export route is raw Express (streams JSON with Content-Disposition) — not
// suitable for defineRoute's envelope wrapper.
router.get(
  '/models/recipes/:id/export',
  (req, res, next) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) { res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid id' } }); return; }
      const recipe = recipes.get(id);
      if (!recipe) { res.status(404).json({ error: { code: 'not_found', message: `Recipe ${id} not found` } }); return; }
      const json = JSON.stringify(recipe, null, 2);
      const safe = recipe.title.replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || `recipe_${id}`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
      res.send(json);
    } catch (err) { next(err); }
  },
);

// ---- POST /models/recipes/import ----

router.post(
  '/models/recipes/import',
  (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
      const loras = Array.isArray(body.loras) ? body.loras as Array<unknown> : [];
      if (!title) { res.status(400).json({ error: { code: 'validation_failed', message: 'title is required' } }); return; }
      if (loras.length === 0) { res.status(400).json({ error: { code: 'validation_failed', message: 'loras must be non-empty' } }); return; }
      const parsed = NewRecipeBodySchema.safeParse(body);
      if (!parsed.success) { res.status(400).json({ error: { code: 'validation_failed', message: 'Invalid recipe shape', details: parsed.error.issues } }); return; }
      const { tags = [], notes } = parsed.data;
      const created = recipes.create({ title: parsed.data.title, notes, tags, loras: normalizeLoras(parsed.data.loras) });
      res.status(200).json({ data: created });
    } catch (err) { next(err); }
  },
);

listRoute.register(router);
getOneRoute.register(router);
createRoute.register(router);
patchRoute.register(router);
deleteRoute.register(router);

export default router;
