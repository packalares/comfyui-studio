// Character routes — CRUD + LoRA training stub for Videoboard characters.

import fs from 'fs';
import path from 'path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { sendError } from '../middleware/errors.js';
import * as repo from '../lib/db/characters.repo.js';
import * as jobTracker from '../services/videoboard/jobTracker.js';
import * as storage from '../services/videoboard/storage.js';
import { paths } from '../config/paths.js';
import type { Character } from '../contracts/videoboard.js';

// ---- Multer setup -----------------------------------------------------------

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, paths.uploadsTmpDir),
    filename: (_req, _file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per photo
});

const router = Router();

// GET /api/videoboard/characters
router.get('/videoboard/characters', (_req: Request, res: Response): void => {
  try {
    res.json(repo.listCharacters());
  } catch (err) { sendError(res, err, 500, 'Failed to list characters'); }
});

// POST /api/videoboard/characters  (multipart: name + photos[])
router.post(
  '/videoboard/characters',
  photoUpload.array('photos'),
  (req: Request, res: Response): void => {
    try {
      const body = req.body as Record<string, unknown>;
      const name = String(body.name ?? 'Unnamed');
      const kind = (body.kind as Character['kind'] | undefined) ?? 'pulid';
      const baseModel = (body.baseModel as Character['baseModel'] | undefined) ?? 'flux1-dev';

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

      const char = repo.createCharacter({
        id: charId,
        name,
        kind,
        baseModel,
        refPhotoUrls,
      });
      res.status(201).json(char);
    } catch (err) { sendError(res, err, 500, 'Failed to create character'); }
  },
);

// GET /api/videoboard/characters/:id
router.get('/videoboard/characters/:id', (req: Request, res: Response): void => {
  try {
    const char = repo.getCharacter(req.params.id as string);
    if (!char) { res.status(404).json({ error: 'Character not found' }); return; }
    res.json(char);
  } catch (err) { sendError(res, err, 500, 'Failed to get character'); }
});

// DELETE /api/videoboard/characters/:id
router.delete('/videoboard/characters/:id', (req: Request, res: Response): void => {
  try {
    const deleted = repo.deleteCharacter(req.params.id as string);
    if (!deleted) { res.status(404).json({ error: 'Character not found' }); return; }
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 500, 'Failed to delete character'); }
});

// POST /api/videoboard/characters/:id/train-lora
router.post('/videoboard/characters/:id/train-lora', (req: Request, res: Response): void => {
  try {
    const id = req.params.id as string;
    const char = repo.getCharacter(id);
    if (!char) { res.status(404).json({ error: 'Character not found' }); return; }

    // Use a dummy projectId matching the character id for job tracking.
    const job = jobTracker.createJob(id, 'train-lora');

    // TODO: wire real LoRA training pipeline.
    //   unloadGpuOnUse pattern from gpuOrchestrator.ts should be applied
    //   before dispatching the training job to free VRAM for the trainer.
    setTimeout(() => {
      jobTracker.updateJob(job.id, { status: 'running', progress: 0.3 });
    }, 1000);

    setTimeout(() => {
      const loraPath = storage.characterDir(id) + '/lora.safetensors';
      repo.updateCharacter(id, { loraPath });
      jobTracker.updateJob(job.id, { status: 'done', progress: 1.0, outputUrl: loraPath });
    }, 3000);

    res.json({ jobId: job.id });
  } catch (err) { sendError(res, err, 500, 'Train LoRA failed'); }
});

export default router;
