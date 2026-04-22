// Server-side configured secrets: Comfy Org API key + HuggingFace token.
//
// GET returns only a `{ configured }` flag so the secret itself never leaves
// the server. PUT writes the trimmed value via the settings service, DELETE
// clears it. No value is ever logged or echoed.

import { Router, type Request, type Response } from 'express';
import * as settings from '../services/settings.js';

const router = Router();

// ---- Comfy Org API key (stored server-side, never returned to client) ----
// Status (`configured` flag) is exposed via `GET /api/system` — there's no
// separate GET here. Only writes remain.
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
// Status flag is carried on `GET /api/system`. Only writes remain.
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

// ---- CivitAI token (for authenticated civitai.com downloads + private content) ----
// Status flag is carried on `GET /api/system`. Only writes remain.
router.put('/settings/civitai-token', (req: Request, res: Response) => {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== 'string' || token.trim().length === 0) {
    res.status(400).json({ error: 'token must be a non-empty string' });
    return;
  }
  settings.setCivitaiToken(token.trim());
  res.json({ configured: true });
});

router.delete('/settings/civitai-token', (_req: Request, res: Response) => {
  settings.clearCivitaiToken();
  res.json({ configured: false });
});

// ---- Pexels API key (stock-photo fallback for audio thumbnails) ----
// Unset → audio rows without embedded cover art skip straight to Picsum.
// Status flag is carried on `GET /api/system`. Only writes remain.
router.put('/settings/pexels-api-key', (req: Request, res: Response) => {
  const { apiKey } = req.body as { apiKey?: unknown };
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    res.status(400).json({ error: 'apiKey must be a non-empty string' });
    return;
  }
  settings.setPexelsApiKey(apiKey.trim());
  res.json({ configured: true });
});

router.delete('/settings/pexels-api-key', (_req: Request, res: Response) => {
  settings.clearPexelsApiKey();
  res.json({ configured: false });
});

export default router;
