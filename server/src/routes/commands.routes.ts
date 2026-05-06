// Commands CRUD: list, get, put, delete command .md files.
// GET /api/commands              list all commands (name + description)
// GET /api/commands/:name        get command body + frontmatter
// PUT /api/commands/:name        write user command
// DELETE /api/commands/:name     delete user command (bundled-only → 404)

import { Router, type Request, type Response } from 'express';
import {
  listCommands,
  getCommand,
  putCommand,
  deleteCommand,
  isCommandBundledOnly,
} from '../services/chat/commands/index.js';
import { isValidLibraryName } from '../services/chat/markdownLibrary/index.js';

const router = Router();

router.get('/commands', (_req: Request, res: Response) => {
  const commands = listCommands();
  res.json({
    commands: commands.map(c => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
    })),
  });
});

router.get('/commands/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidLibraryName(name)) {
    res.status(400).json({ error: 'invalid command name' });
    return;
  }
  const cmd = getCommand(name);
  if (!cmd) {
    res.status(404).json({ error: 'command not found' });
    return;
  }
  res.json({ name: cmd.name, body: cmd.body, frontmatter: cmd.frontmatter, argumentHint: cmd.argumentHint });
});

router.put('/commands/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidLibraryName(name)) {
    res.status(400).json({ error: 'invalid command name' });
    return;
  }
  const body = req.body as { body?: unknown };
  if (typeof body.body !== 'string') {
    res.status(400).json({ error: 'body must be a string' });
    return;
  }
  try {
    putCommand(name, body.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({ ok: true });
});

router.delete('/commands/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidLibraryName(name)) {
    res.status(400).json({ error: 'invalid command name' });
    return;
  }
  if (isCommandBundledOnly(name)) {
    res.status(404).json({ error: 'bundled commands cannot be deleted; create a user override first' });
    return;
  }
  let removed: boolean;
  try {
    removed = deleteCommand(name);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!removed) {
    res.status(404).json({ error: 'command not found in user dir' });
    return;
  }
  res.json({ ok: true });
});

export { router as commandsRouter };
