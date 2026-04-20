// Pilot extraction: minimal route module.
//
// Every subsequent route extraction (Agent B's phase) follows this template:
//  - One file per thematic group under `src/routes/*.routes.ts`.
//  - Default-export an Express `Router`.
//  - Mounted from `api.ts` (or directly in `index.ts` for non-`/api` paths).
//
// Keep this file short and free of service imports so it proves the pattern
// without accidentally growing into another monolith.

import { Router, type Request, type Response } from 'express';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
