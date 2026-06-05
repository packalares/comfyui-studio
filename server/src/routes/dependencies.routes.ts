// `POST /api/check-dependencies` — thin HTTP wrapper around the shared
// `checkTemplateDependencies` service. The actual workflow walk + model /
// plugin resolution lives in `services/templates/dependencyCheck.ts` so the
// chat tool can call it directly without an HTTP self-request.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { ValidationError, InternalError } from '../lib/errors.js';
import { checkTemplateDependencies } from '../services/templates/dependencyCheck.js';

const router = Router();

router.post('/check-dependencies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { templateName } = req.body as Record<string, unknown>;
    if (!templateName) {
      throw new ValidationError('templateName is required');
    }
    const result = await checkTemplateDependencies(templateName as string);
    res.json(result);
  } catch (err) {
    next(err instanceof Error ? err : new InternalError('Dependency check failed'));
  }
});

export default router;
