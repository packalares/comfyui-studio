// Handler for `POST /models/download-hf-repo`. Validates the
// `owner/repo` shape + relative `directory` and dispatches to the
// HF repo download service. Extracted from `models.routes.ts` to keep
// that file under the 250-line cap.

import type { Request, Response, RequestHandler } from 'express';
import * as models from '../services/models/models.service.js';
import * as settings from '../services/settings.js';
import { trackDownload } from '../services/downloads.js';
import { sendError } from '../middleware/errors.js';

export const handleDownloadHfRepo: RequestHandler = async (req: Request, res: Response) => {
  try {
    const { hfRepo, directory, name, hfToken } = (req.body || {}) as {
      hfRepo?: string; directory?: string; name?: string; hfToken?: string;
    };
    if (!hfRepo || !/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/.test(hfRepo)) {
      res.status(400).json({ error: 'hfRepo required (format "owner/repo")' });
      return;
    }
    if (!directory || directory.includes('..') || directory.startsWith('/')) {
      res.status(400).json({ error: 'directory required; must be relative without ".."' });
      return;
    }
    const out = await models.downloadHfRepo(
      hfRepo, directory, name || hfRepo,
      { hfToken: hfToken || settings.getHfToken() },
    );
    trackDownload(out.taskId, { modelName: out.modelName, filename: out.modelName });
    res.json({ success: true, taskId: out.taskId, modelName: out.modelName });
  } catch (err) { sendError(res, err, 500, 'HF repo download failed'); }
};
