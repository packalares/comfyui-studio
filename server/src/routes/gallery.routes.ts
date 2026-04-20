// Gallery listing — flat array of every generated output the server knows
// about, built from ComfyUI's history. Fails open to an empty list so the
// dashboard still renders when ComfyUI is unreachable.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';

const router = Router();

router.get('/gallery', async (_req: Request, res: Response) => {
  try {
    res.json(await comfyui.getGalleryItems());
  } catch {
    res.json([]);
  }
});

export default router;
