// Capability-pack routes.
// GET  /api/packs                     — registry merged with installed state. Scope: system:read.
// POST /api/packs/:id/install         — kick off pip+model install, returns taskId. Scope: packs:install.
// POST /api/packs/:id/uninstall       — flip install state off (see install.ts TODO). Scope: packs:install.
// GET  /api/packs/progress/:taskId    — poll install/uninstall progress. Scope: system:read.

import { Router } from 'express';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError } from '../lib/errors.js';
import * as packsRepo from '../lib/db/packs.repo.js';
import { isPackId, listPackDefinitions } from '../services/packs/registry.js';
import { installPack, uninstallPack, getInstallProgress } from '../services/packs/install.js';
import {
  PackListResponseSchema,
  PackParamsSchema,
  PackTaskStartedSchema,
  PackTaskParamsSchema,
  PackTaskProgressSchema,
} from '../contracts/packs.contract.js';

const listRoute = defineRoute({
  method: 'GET',
  path: '/packs',
  response: PackListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['packs'],
  summary: 'List capability packs (registry merged with installed state)',
}, (ctx) => {
  const installedById = new Map(packsRepo.listPacks().map((r) => [r.id, r]));
  const items = listPackDefinitions().map((def) => {
    const row = installedById.get(def.id);
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      installed: row?.installed ?? false,
      version: row?.version ?? null,
      installedAt: row?.installedAt ?? null,
    };
  });
  return ctx.ok({ items });
});

const installRoute = defineRoute({
  method: 'POST',
  path: '/packs/:id/install',
  params: PackParamsSchema,
  response: PackTaskStartedSchema,
  auth: { required: true, scopes: ['packs:install'] },
  tags: ['packs'],
  summary: 'Install a capability pack (pip deps + models), fire-and-forget',
}, (ctx) => {
  if (!isPackId(ctx.params.id)) throw new NotFoundError(`Unknown pack: ${ctx.params.id}`);
  const taskId = installPack(ctx.params.id);
  return ctx.ok({ taskId });
});

const uninstallRoute = defineRoute({
  method: 'POST',
  path: '/packs/:id/uninstall',
  params: PackParamsSchema,
  response: PackTaskStartedSchema,
  auth: { required: true, scopes: ['packs:install'] },
  tags: ['packs'],
  summary: 'Uninstall a capability pack (state flip only — deps/models stay on disk)',
}, (ctx) => {
  if (!isPackId(ctx.params.id)) throw new NotFoundError(`Unknown pack: ${ctx.params.id}`);
  const taskId = uninstallPack(ctx.params.id);
  return ctx.ok({ taskId });
});

const progressRoute = defineRoute({
  method: 'GET',
  path: '/packs/progress/:taskId',
  params: PackTaskParamsSchema,
  response: PackTaskProgressSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['packs'],
  summary: 'Poll pack install/uninstall progress',
}, (ctx) => {
  const p = getInstallProgress(ctx.params.taskId);
  if (!p) throw new NotFoundError('Task not found');
  return ctx.ok(p);
});

const router = Router();
[listRoute, installRoute, uninstallRoute, progressRoute].forEach((r) => r.register(router));

export default router;
