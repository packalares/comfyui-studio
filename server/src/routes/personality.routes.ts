// Personality CRUD: souls, skills, commands, pending edits, and memory.
// All four item flavors share /:type/:name; memory is a singleton (no name).

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError, ForbiddenError } from '../lib/errors.js';
import {
  loadSoul, writeSoul, deleteSoul,
  isBundledOnly as isSoulBundledOnly, isValidSoulName,
  loadMemoryBody, writeMemoryBody,
  getPendingEdit, deletePendingEdit, applyPendingEdit,
  getPersonalitySummary,
} from '../services/chat/personality.js';
import {
  getSkill, putSkill, deleteSkill, isSkillBundledOnly,
} from '../services/chat/skills.js';
import {
  getCommand, putCommand, deleteCommand, isCommandBundledOnly,
} from '../services/chat/commands.js';
import { isValidLibraryName } from '../services/chat/markdownLibrary/index.js';
import {
  PersonalityTypeParamSchema, WriteBodySchema, EditActionBodySchema,
  ItemDetailSchema, MemoryBodySchema, MemoryResponseSchema,
  OkResponseSchema, EditAcceptResponseSchema,
} from '../contracts/personality.contract.js';
import { PersonalitySummarySchema } from '../contracts/system.contract.js';

// ---- Library dispatch table ----

interface LibraryHandlers {
  load: (name: string) => z.infer<typeof ItemDetailSchema> | null;
  put: (name: string, body: string) => void;
  remove: (name: string) => boolean;
  isBundledOnly: (name: string) => boolean;
  validate: (name: string) => boolean;
  label: string;
}

type LibraryType = 'soul' | 'skill' | 'command';

const LIBRARY: Record<LibraryType, LibraryHandlers> = {
  soul: {
    load: (name) => { const s = loadSoul(name); return s ? { name: s.name, body: s.body, frontmatter: s.frontmatter } : null; },
    put: writeSoul,
    remove: deleteSoul,
    isBundledOnly: isSoulBundledOnly,
    validate: isValidSoulName,
    label: 'soul',
  },
  skill: {
    load: (name) => { const s = getSkill(name); return s ? { name: s.name, body: s.body, frontmatter: s.frontmatter as Record<string, unknown>, scripts: s.scripts } : null; },
    put: putSkill,
    remove: deleteSkill,
    isBundledOnly: isSkillBundledOnly,
    validate: isValidLibraryName,
    label: 'skill',
  },
  command: {
    load: (name) => { const c = getCommand(name); return c ? { name: c.name, body: c.body, frontmatter: c.frontmatter as Record<string, unknown>, argumentHint: c.argumentHint } : null; },
    put: putCommand,
    remove: deleteCommand,
    isBundledOnly: isCommandBundledOnly,
    validate: isValidLibraryName,
    label: 'command',
  },
};

function isLibraryType(t: string): t is LibraryType {
  return t === 'soul' || t === 'skill' || t === 'command';
}

// ---- Memory singleton ----

const getMemoryRoute = defineRoute({
  method: 'GET',
  path: '/personality/memory',
  response: MemoryResponseSchema,
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['personality'],
  summary: 'Get memory body',
}, ({ ok }) => ok({ body: loadMemoryBody() }));

const putMemoryRoute = defineRoute({
  method: 'PUT',
  path: '/personality/memory',
  body: MemoryBodySchema,
  response: OkResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['personality'],
  summary: 'Update memory body',
}, ({ body, ok }) => {
  writeMemoryBody(body.body);
  return ok({ ok: true as const });
});

// ---- Summary ----

const summaryRoute = defineRoute({
  method: 'GET',
  path: '/personality',
  response: PersonalitySummarySchema,
  auth: { required: false },
  tags: ['personality'],
  summary: 'Full personality summary (souls, skills, commands, edits)',
}, ({ ok }) => ok(getPersonalitySummary()));

// ---- GET /personality/:type/:name ----

const getItemRoute = defineRoute({
  method: 'GET',
  path: '/personality/:type/:name',
  params: PersonalityTypeParamSchema,
  response: z.union([ItemDetailSchema, z.record(z.string(), z.unknown())]),
  auth: { required: true, scopes: ['catalog:read'] },
  tags: ['personality'],
  summary: 'Get soul/skill/command body or pending edit',
}, ({ params, ok }) => {
  const { type, name } = params;

  if (type === 'edit') {
    const edit = getPendingEdit(name);
    if (!edit) throw new NotFoundError('pending edit not found');
    return ok(edit as unknown as z.infer<typeof ItemDetailSchema>);
  }

  if (!isLibraryType(type)) throw new NotFoundError(`unknown personality type: ${type}`);
  const handlers = LIBRARY[type];
  if (!handlers.validate(name)) throw new ValidationError(`invalid ${handlers.label} name`);
  const item = handlers.load(name);
  if (!item) throw new NotFoundError(`${handlers.label} not found`);
  return ok(item);
});

// ---- PUT /personality/:type/:name ----

const putItemRoute = defineRoute({
  method: 'PUT',
  path: '/personality/:type/:name',
  params: PersonalityTypeParamSchema,
  body: WriteBodySchema,
  response: OkResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['personality'],
  summary: 'Write soul/skill/command body',
}, ({ params, body, ok }) => {
  if (!isLibraryType(params.type)) throw new ValidationError(`PUT not allowed on type: ${params.type}`);
  const handlers = LIBRARY[params.type];
  if (!handlers.validate(params.name)) throw new ValidationError(`invalid ${handlers.label} name`);
  handlers.put(params.name, body.body);
  return ok({ ok: true as const });
});

// ---- POST /personality/:type/:name (edit actions) ----

const postItemRoute = defineRoute({
  method: 'POST',
  path: '/personality/:type/:name',
  params: PersonalityTypeParamSchema,
  body: EditActionBodySchema,
  response: EditAcceptResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['personality'],
  summary: 'Accept a pending soul edit',
}, ({ params, ok }) => {
  if (params.type !== 'edit') throw new ValidationError(`POST not allowed on type: ${params.type}`);
  const result = applyPendingEdit(params.name);
  if (!result.ok && result.soulName === '') throw new NotFoundError('pending edit not found');
  return ok({ ok: result.ok, soulName: result.soulName });
});

// ---- DELETE /personality/:type/:name ----

const deleteItemRoute = defineRoute({
  method: 'DELETE',
  path: '/personality/:type/:name',
  params: PersonalityTypeParamSchema,
  response: OkResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['personality'],
  summary: 'Delete/reject a soul/skill/command/edit',
}, ({ params, ok }) => {
  const { type, name } = params;

  if (type === 'edit') {
    if (!deletePendingEdit(name)) throw new NotFoundError('pending edit not found');
    return ok({ ok: true as const });
  }

  if (!isLibraryType(type)) throw new NotFoundError(`unknown personality type: ${type}`);
  const handlers = LIBRARY[type];
  if (!handlers.validate(name)) throw new ValidationError(`invalid ${handlers.label} name`);
  if (handlers.isBundledOnly(name)) throw new NotFoundError(`bundled ${handlers.label}s cannot be deleted; create a user override first`);

  if (!handlers.remove(name)) throw new NotFoundError(`${handlers.label} not found in user dir`);
  return ok({ ok: true as const });
});

const router = Router();
getMemoryRoute.register(router);
putMemoryRoute.register(router);
summaryRoute.register(router);
// NOTE: /personality/:type/:name must come after /personality/memory
getItemRoute.register(router);
putItemRoute.register(router);
postItemRoute.register(router);
deleteItemRoute.register(router);

export { router as personalityRouter };
