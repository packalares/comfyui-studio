// `POST /api/check-dependencies` — thin HTTP wrapper around the shared
// `checkTemplateDependencies` service. The actual workflow walk + model /
// plugin resolution lives in `services/templates/dependencyCheck.ts` so the
// chat tool can call it directly without an HTTP self-request.

import { Router, type Request, type Response } from 'express';
import { sendError } from '../middleware/errors.js';
import { checkTemplateDependencies } from '../services/templates/dependencyCheck.js';

const router = Router();

router.post('/check-dependencies', async (req: Request, res: Response) => {
  try {
    const { templateName } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }
    const result = await checkTemplateDependencies(templateName);
    res.json(result);
  } catch (err) {
    sendError(res, err, 500, 'Dependency check failed');
  }
});

export default router;
