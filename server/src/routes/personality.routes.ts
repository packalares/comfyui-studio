// Personality CRUD: souls (system-prompt personas) and memory (persistent
// user facts). Souls overlay user dir over bundled seeds; memory is a single
// user-writable file.
//
// DELETE on a bundled-only soul returns 404: there is nothing to remove from
// the user dir. The client should write a user override first if it wants a
// customised version it can then delete.

import { Router, type Request, type Response } from 'express';
import {
  listSouls,
  loadSoul,
  writeSoul,
  deleteSoul,
  isBundledOnly,
  getDefaultSoulName,
  isValidSoulName,
  loadMemoryBody,
  writeMemoryBody,
} from '../services/chat/personality/index.js';
import {
  listPendingEdits,
  getPendingEdit,
  deletePendingEdit,
  applyPendingEdit,
} from '../services/chat/personality/pendingEdits.js';

const router = Router();

// GET /api/personality/souls
router.get('/personality/souls', (_req: Request, res: Response) => {
  const souls = listSouls();
  res.json({
    souls: souls.map(s => ({ name: s.name, description: s.description })),
  });
});

// GET /api/personality/souls/:name
router.get('/personality/souls/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidSoulName(name)) {
    res.status(400).json({ error: 'invalid soul name' });
    return;
  }
  const soul = loadSoul(name);
  if (!soul) {
    res.status(404).json({ error: 'soul not found' });
    return;
  }
  res.json({ name: soul.name, body: soul.body, frontmatter: soul.frontmatter });
});

// PUT /api/personality/souls/:name
router.put('/personality/souls/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidSoulName(name)) {
    res.status(400).json({ error: 'invalid soul name' });
    return;
  }
  const body = req.body as { body?: unknown };
  if (typeof body.body !== 'string') {
    res.status(400).json({ error: 'body must be a string' });
    return;
  }
  try {
    writeSoul(name, body.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({ ok: true });
});

// DELETE /api/personality/souls/:name
router.delete('/personality/souls/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidSoulName(name)) {
    res.status(400).json({ error: 'invalid soul name' });
    return;
  }
  // Bundled-only: no user file exists, nothing to delete.
  if (isBundledOnly(name)) {
    res.status(404).json({ error: 'bundled souls cannot be deleted; create a user override first' });
    return;
  }
  let removed: boolean;
  try {
    removed = deleteSoul(name);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!removed) {
    res.status(404).json({ error: 'soul not found in user dir' });
    return;
  }
  res.json({ ok: true });
});

// GET /api/personality/memory
router.get('/personality/memory', (_req: Request, res: Response) => {
  const body = loadMemoryBody();
  res.json({ body });
});

// PUT /api/personality/memory
router.put('/personality/memory', (req: Request, res: Response) => {
  const body = req.body as { body?: unknown };
  if (typeof body.body !== 'string') {
    res.status(400).json({ error: 'body must be a string' });
    return;
  }
  try {
    writeMemoryBody(body.body);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({ ok: true });
});

// GET /api/personality/default-soul
router.get('/personality/default-soul', (_req: Request, res: Response) => {
  const name = getDefaultSoulName();
  res.json({ name });
});

// GET /api/personality/pending-edits
router.get('/personality/pending-edits', (_req: Request, res: Response) => {
  res.json({ edits: listPendingEdits() });
});

// GET /api/personality/pending-edits/:id
router.get('/personality/pending-edits/:id', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const edit = getPendingEdit(id);
  if (!edit) { res.status(404).json({ error: 'pending edit not found' }); return; }
  res.json(edit);
});

// POST /api/personality/pending-edits/:id/accept — apply the proposed change
router.post('/personality/pending-edits/:id/accept', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const result = applyPendingEdit(id);
  if (!result.ok && result.soulName === '') {
    res.status(404).json({ error: 'pending edit not found' });
    return;
  }
  res.json({ ok: result.ok });
});

// DELETE /api/personality/pending-edits/:id — reject (discard without applying)
router.delete('/personality/pending-edits/:id', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const removed = deletePendingEdit(id);
  if (!removed) { res.status(404).json({ error: 'pending edit not found' }); return; }
  res.json({ ok: true });
});

export { router as personalityRouter };
