// Unified personality CRUD: souls, skills, commands, and pending soul-edit
// proposals share the same `/personality/:type/:name` shape, dispatched to
// per-type registries below. Memory is a singleton (no name) so it keeps
// distinct paths. PUT writes a body (soul|skill|command); POST runs an
// action ({action:'accept'} on edit); DELETE removes the user override (or
// rejects the edit). GET /personality returns the summary used by /system.

import { Router, type Request, type Response } from 'express';
import {
  loadSoul, writeSoul, deleteSoul,
  isBundledOnly as isSoulBundledOnly, isValidSoulName,
  loadMemoryBody, writeMemoryBody,
} from '../services/chat/personality/index.js';
import {
  getSkill, putSkill, deleteSkill, isSkillBundledOnly,
} from '../services/chat/skills/index.js';
import {
  getCommand, putCommand, deleteCommand, isCommandBundledOnly,
} from '../services/chat/commands/index.js';
import { isValidLibraryName } from '../services/chat/markdownLibrary/index.js';
import {
  getPendingEdit, deletePendingEdit, applyPendingEdit,
} from '../services/chat/personality/pendingEdits.js';
import { getPersonalitySummary } from '../services/chat/personality/summary.js';

const router = Router();

// ---------- Memory (singleton — must be declared before /:type/:name) ----------

router.get('/personality/memory', (_req: Request, res: Response) => {
  res.json({ body: loadMemoryBody() });
});

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

// ---------- Summary ----------

router.get('/personality', (_req: Request, res: Response) => {
  res.json(getPersonalitySummary());
});

// ---------- Library registry dispatch ----------

interface ItemDetail {
  name: string;
  body: string;
  frontmatter: Record<string, unknown>;
  // Type-specific extras carried through verbatim.
  scripts?: string[];
  argumentHint?: string;
}

interface LibraryHandlers {
  load: (name: string) => ItemDetail | null;
  put: (name: string, body: string) => void;
  remove: (name: string) => boolean;
  isBundledOnly: (name: string) => boolean;
  validate: (name: string) => boolean;
  label: string;
}

const LIBRARY: Record<'soul' | 'skill' | 'command', LibraryHandlers> = {
  soul: {
    load: name => {
      const s = loadSoul(name);
      return s ? { name: s.name, body: s.body, frontmatter: s.frontmatter } : null;
    },
    put: writeSoul,
    remove: deleteSoul,
    isBundledOnly: isSoulBundledOnly,
    validate: isValidSoulName,
    label: 'soul',
  },
  skill: {
    load: name => {
      const s = getSkill(name);
      return s ? { name: s.name, body: s.body, frontmatter: s.frontmatter, scripts: s.scripts } : null;
    },
    put: putSkill,
    remove: deleteSkill,
    isBundledOnly: isSkillBundledOnly,
    validate: isValidLibraryName,
    label: 'skill',
  },
  command: {
    load: name => {
      const c = getCommand(name);
      return c ? { name: c.name, body: c.body, frontmatter: c.frontmatter, argumentHint: c.argumentHint } : null;
    },
    put: putCommand,
    remove: deleteCommand,
    isBundledOnly: isCommandBundledOnly,
    validate: isValidLibraryName,
    label: 'command',
  },
};

function isLibraryType(t: string): t is keyof typeof LIBRARY {
  return t === 'soul' || t === 'skill' || t === 'command';
}

// Avoid the 405-as-string-equality dance — `edit` is the only non-library
// type and it has a tiny dedicated handler block below.

// ---------- GET /personality/:type/:name ----------

router.get('/personality/:type/:name', (req: Request, res: Response) => {
  const type = String(req.params.type ?? '');
  const name = String(req.params.name ?? '');

  if (type === 'edit') {
    const edit = getPendingEdit(name);
    if (!edit) { res.status(404).json({ error: 'pending edit not found' }); return; }
    res.json(edit);
    return;
  }

  if (!isLibraryType(type)) {
    res.status(404).json({ error: `unknown personality type: ${type}` });
    return;
  }
  const handlers = LIBRARY[type];
  if (!handlers.validate(name)) {
    res.status(400).json({ error: `invalid ${handlers.label} name` });
    return;
  }
  const item = handlers.load(name);
  if (!item) { res.status(404).json({ error: `${handlers.label} not found` }); return; }
  res.json(item);
});

// ---------- PUT /personality/:type/:name (write body) ----------

router.put('/personality/:type/:name', (req: Request, res: Response) => {
  const type = String(req.params.type ?? '');
  if (!isLibraryType(type)) {
    res.status(405).json({ error: `PUT not allowed on type: ${type}` });
    return;
  }
  const handlers = LIBRARY[type];
  const name = String(req.params.name ?? '');
  if (!handlers.validate(name)) {
    res.status(400).json({ error: `invalid ${handlers.label} name` });
    return;
  }
  const body = req.body as { body?: unknown };
  if (typeof body.body !== 'string') {
    res.status(400).json({ error: 'body must be a string' });
    return;
  }
  try {
    handlers.put(name, body.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({ ok: true });
});

// ---------- POST /personality/:type/:name (edit actions) ----------

router.post('/personality/:type/:name', (req: Request, res: Response) => {
  const type = String(req.params.type ?? '');
  if (type !== 'edit') {
    res.status(405).json({ error: `POST not allowed on type: ${type}` });
    return;
  }
  const id = String(req.params.name ?? '');
  const action = (req.body as { action?: unknown })?.action;
  if (action !== 'accept') {
    res.status(400).json({ error: 'unknown action; expected "accept"' });
    return;
  }
  const result = applyPendingEdit(id);
  if (!result.ok && result.soulName === '') {
    res.status(404).json({ error: 'pending edit not found' });
    return;
  }
  res.json({ ok: result.ok, soulName: result.soulName });
});

// ---------- DELETE /personality/:type/:name ----------

router.delete('/personality/:type/:name', (req: Request, res: Response) => {
  const type = String(req.params.type ?? '');
  const name = String(req.params.name ?? '');

  if (type === 'edit') {
    const removed = deletePendingEdit(name);
    if (!removed) { res.status(404).json({ error: 'pending edit not found' }); return; }
    res.json({ ok: true });
    return;
  }

  if (!isLibraryType(type)) {
    res.status(404).json({ error: `unknown personality type: ${type}` });
    return;
  }
  const handlers = LIBRARY[type];
  if (!handlers.validate(name)) {
    res.status(400).json({ error: `invalid ${handlers.label} name` });
    return;
  }
  if (handlers.isBundledOnly(name)) {
    res.status(404).json({
      error: `bundled ${handlers.label}s cannot be deleted; create a user override first`,
    });
    return;
  }
  let removed: boolean;
  try {
    removed = handlers.remove(name);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!removed) {
    res.status(404).json({ error: `${handlers.label} not found in user dir` });
    return;
  }
  res.json({ ok: true });
});

export { router as personalityRouter };
