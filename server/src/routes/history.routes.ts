// ComfyUI history proxy: full history list + per-prompt output inspector.
//
// `/history/:promptId` flattens per-node output maps into a single array, then
// tags each file with a `mediaType` derived from its extension so SaveVideo
// (mp4 under `images`) and SaveAudio (under `audio`) are recognized correctly
// rather than lumped in as images.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';

const router = Router();

router.get('/history', async (_req: Request, res: Response) => {
  try {
    const history = await comfyui.getHistory();
    res.json(history);
  } catch {
    res.json({});
  }
});

router.get('/history/:promptId', async (req: Request, res: Response) => {
  try {
    const promptId = req.params.promptId as string;
    const data = await comfyui.fetchComfyUI<
      Record<string, { outputs?: Record<string, Record<string, unknown>> }>
    >(`/api/history/${promptId}`);
    const entry = data[promptId];
    if (!entry?.outputs) {
      res.json({ outputs: [] });
      return;
    }
    const outputs: Array<{
      filename: string;
      subfolder: string;
      type: string;
      mediaType: string;
    }> = [];
    for (const nodeOutput of Object.values(entry.outputs)) {
      for (const f of comfyui.collectNodeOutputFiles(nodeOutput)) {
        outputs.push({
          filename: f.filename,
          subfolder: f.subfolder || '',
          type: f.type || 'output',
          mediaType: comfyui.detectMediaType(f.filename),
        });
      }
    }
    res.json({ outputs });
  } catch {
    res.json({ outputs: [] });
  }
});

export default router;
