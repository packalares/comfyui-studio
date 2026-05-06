// Skills CRUD: list, get, put, delete skill SKILL.md files.
// GET /api/skills              list all skills (name + description)
// GET /api/skills/:name        get skill body + frontmatter
// PUT /api/skills/:name        write user skill
// DELETE /api/skills/:name     delete user skill (bundled-only → 404)

import { Router, type Request, type Response } from 'express';
import {
  listSkills,
  getSkill,
  putSkill,
  deleteSkill,
  isSkillBundledOnly,
} from '../services/chat/skills/index.js';
import { isValidLibraryName } from '../services/chat/markdownLibrary/index.js';

const router = Router();

router.get('/skills', (_req: Request, res: Response) => {
  const skills = listSkills();
  res.json({
    skills: skills.map(s => ({ name: s.name, description: s.description, scripts: s.scripts })),
  });
});

router.get('/skills/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidLibraryName(name)) {
    res.status(400).json({ error: 'invalid skill name' });
    return;
  }
  const skill = getSkill(name);
  if (!skill) {
    res.status(404).json({ error: 'skill not found' });
    return;
  }
  res.json({ name: skill.name, body: skill.body, frontmatter: skill.frontmatter, scripts: skill.scripts });
});

router.put('/skills/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidLibraryName(name)) {
    res.status(400).json({ error: 'invalid skill name' });
    return;
  }
  const body = req.body as { body?: unknown };
  if (typeof body.body !== 'string') {
    res.status(400).json({ error: 'body must be a string' });
    return;
  }
  try {
    putSkill(name, body.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.json({ ok: true });
});

router.delete('/skills/:name', (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  if (!isValidLibraryName(name)) {
    res.status(400).json({ error: 'invalid skill name' });
    return;
  }
  if (isSkillBundledOnly(name)) {
    res.status(404).json({ error: 'bundled skills cannot be deleted; create a user override first' });
    return;
  }
  let removed: boolean;
  try {
    removed = deleteSkill(name);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!removed) {
    res.status(404).json({ error: 'skill not found in user dir' });
    return;
  }
  res.json({ ok: true });
});

export { router as skillsRouter };
