// Server-side configured secrets: Comfy Org API key + HuggingFace token.
//
// GET returns only a `{ configured }` flag so the secret itself never leaves
// the server. PUT writes the trimmed value via the settings service, DELETE
// clears it. No value is ever logged or echoed.

import { Router, type Request, type Response } from 'express';
import * as settings from '../services/settings.js';

const router = Router();

// ---- Comfy Org API key (stored server-side, never returned to client) ----
router.get('/settings/api-key', (_req: Request, res: Response) => {
  res.json({ configured: settings.isApiKeyConfigured() });
});

router.put('/settings/api-key', (req: Request, res: Response) => {
  const { apiKey } = req.body as { apiKey?: unknown };
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    res.status(400).json({ error: 'apiKey must be a non-empty string' });
    return;
  }
  settings.setApiKey(apiKey.trim());
  res.json({ configured: true });
});

router.delete('/settings/api-key', (_req: Request, res: Response) => {
  settings.clearApiKey();
  res.json({ configured: false });
});

// ---- HuggingFace token (for gated models + private HEAD/GET requests) ----
router.get('/settings/hf-token', (_req: Request, res: Response) => {
  res.json({ configured: settings.isHfTokenConfigured() });
});

router.put('/settings/hf-token', (req: Request, res: Response) => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || token.trim().length === 0) {
    res.status(400).json({ error: 'token must be a non-empty string' });
    return;
  }
  settings.setHfToken(token.trim());
  res.json({ configured: true });
});

router.delete('/settings/hf-token', (_req: Request, res: Response) => {
  settings.clearHfToken();
  res.json({ configured: false });
});

export default router;
