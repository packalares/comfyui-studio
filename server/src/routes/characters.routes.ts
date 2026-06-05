// Character routes — CRUD + LoRA training stub for Videoboard characters.

import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError } from '../lib/errors.js';
import * as repo from '../lib/db/characters.repo.js';
import * as jobTracker from '../services/videoboard/jobTracker.js';
import * as storage from '../services/videoboard/storage.js';
import { paths } from '../config/paths.js';
import {
  CharacterSchema,
  OkSchema,
  JobStartedSchema,
} from '../contracts/videoboard.js';

// ---- Multer ------------------------------------------------------------------

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, paths.uploadsTmpDir),
    filename: (_req, _file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ---- defineRoute-based routes -----------------------------------------------

const IdParams = z.object({ id: z.string() });

const listCharactersRoute = defineRoute({
  method: 'GET',
  path: '/videoboard/characters',
  response: z.array(CharacterSchema),
  auth: { required: true, scopes: ['videoboard:read'] },
  tags: ['characters'],
  summary: 'List characters',
}, (ctx) => ctx.ok(repo.listCharacters()));

const getCharacterRoute = defineRoute({
  method: 'GET',
  path: '/videoboard/characters/:id',
  params: IdParams,
  response: CharacterSchema,
  auth: { required: true, scopes: ['videoboard:read'] },
  tags: ['characters'],
  summary: 'Get a character',
}, (ctx) => {
  const char = repo.getCharacter(ctx.params.id);
  if (!char) throw new NotFoundError('Character not found');
  return ctx.ok(char);
});

const deleteCharacterRoute = defineRoute({
  method: 'DELETE',
  path: '/videoboard/characters/:id',
  params: IdParams,
  response: OkSchema,
  auth: { required: true, scopes: ['videoboard:write'] },
  tags: ['characters'],
  summary: 'Delete a character',
}, (ctx) => {
  const deleted = repo.deleteCharacter(ctx.params.id);
  if (!deleted) throw new NotFoundError('Character not found');
  return ctx.ok({ ok: true as const });
});

const trainLoraRoute = defineRoute({
  method: 'POST',
  path: '/videoboard/characters/:id/train-lora',
  params: IdParams,
  response: JobStartedSchema,
  auth: { required: true, scopes: ['videoboard:render'] },
  tags: ['characters'],
  summary: 'Train LoRA for a character (async stub)',
}, (ctx) => {
  const { id } = ctx.params;
  const char = repo.getCharacter(id);
  if (!char) throw new NotFoundError('Character not found');

  const job = jobTracker.createJob(id, 'train-lora');
  // TODO: wire real LoRA training pipeline.
  setTimeout(() => { jobTracker.updateJob(job.id, { status: 'running', progress: 0.3 }); }, 1000);
  setTimeout(() => {
    const loraPath = storage.characterDir(id) + '/lora.safetensors';
    repo.updateCharacter(id, { loraPath });
    jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl: loraPath });
  }, 3000);

  return ctx.ok({ jobId: job.id });
});

// ---- Router assembly --------------------------------------------------------

const router = Router();

listCharactersRoute.register(router);
getCharacterRoute.register(router);
deleteCharacterRoute.register(router);
trainLoraRoute.register(router);

// POST /api/videoboard/characters — multipart; registered manually.
router.post(
  '/videoboard/characters',
  photoUpload.array('photos'),
  (req, res, next): void => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = String(body.name ?? 'Unnamed');
      const kind = (body.kind as import('../contracts/videoboard.js').Character['kind'] | undefined) ?? 'pulid';
      const baseModel = (body.baseModel as import('../contracts/videoboard.js').Character['baseModel'] | undefined) ?? 'flux1-dev';

      const charId = randomUUID();
      storage.ensureCharacterDir(charId);

      const files = req.files as Express.Multer.File[] | undefined ?? [];
      const refPhotoUrls: string[] = [];
      files.forEach((file, i) => {
        const ext = path.extname(file.originalname).replace('.', '') || 'jpg';
        const dest = storage.characterRefPhotoPath(charId, i, ext);
        fs.renameSync(file.path, dest);
        refPhotoUrls.push(dest);
      });

      const char = repo.createCharacter({ id: charId, name, kind, baseModel, refPhotoUrls });
      res.status(201).json({ data: char });
    } catch (err) {
      next(err instanceof Error ? err : new Error(String(err)));
    }
  },
);

export default router;
