// Consolidated settings routes — three endpoints replace the eight that used
// to be split between `settings.routes.ts` and `settings.tools.routes.ts`:
//
//   PUT    /settings/:key       — write secret | chat | tools
//   DELETE /settings/:key       — clear one named secret (other keys → 405)
//   POST   /settings/probe      — validate an Ollama or SearXNG URL
//
// Reads for chat/tools live on `GET /system` so the dashboard pulls every
// config in a single trip. Status flags for secrets stay there too — the
// stored values themselves never leave the server.

import { Router, type Request, type Response } from 'express';
import {
  isSecretName,
  putSecret,
  putChat,
  putTools,
  clearSecretByName,
} from './settings.handlers.js';
import { runProbe } from './settings.probe.js';

const router = Router();

router.put('/settings/:key', (req: Request, res: Response) => {
  const key = req.params.key;
  if (key === 'secret') return putSecret(req, res);
  if (key === 'chat') return putChat(req, res);
  if (key === 'tools') return putTools(req, res);
  res.status(404).json({ error: 'unknown settings key' });
});

router.delete('/settings/:key', (req: Request, res: Response) => {
  const key = req.params.key;
  if (key !== 'secret') {
    res.status(405).json({ error: 'DELETE only supported for secret' });
    return;
  }
  const name = String(req.query.name ?? '');
  if (!isSecretName(name)) {
    res.status(400).json({ error: 'unknown secret name' });
    return;
  }
  clearSecretByName(name);
  res.json({ configured: false });
});

router.post('/settings/probe', async (req: Request, res: Response) => {
  await runProbe(req, res);
});

export default router;
