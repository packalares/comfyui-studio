// Capability-pack routes.
// GET    /api/packs                              — registry merged with installed state. Scope: system:read.
// POST   /api/packs/:id/install                  — kick off pip+model install, returns taskId. Scope: packs:install.
// POST   /api/packs/:id/uninstall                — flip install state off (see install.ts TODO). Scope: packs:install.
// GET    /api/packs/progress/:taskId              — poll install/uninstall/model-download progress. Scope: system:read.
// GET    /api/packs/:id/settings                  — model catalog + settings (registry merged w/ DB). Scope: system:read.
// PATCH  /api/packs/:id/settings                  — set model selection / repo overrides / settings. Scope: packs:install.
// POST   /api/packs/:id/models/:modelId/download  — download one model now, returns taskId. Scope: packs:install.
// DELETE /api/packs/:id/models/:modelId           — delete a downloaded model from disk, mark absent. Scope: packs:install.

import { Router } from 'express';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import * as packsRepo from '../lib/db/packs.repo.js';
import { isPackId, getPackModel, listPackDefinitions } from '../services/packs/registry.js';
import {
  installPack,
  uninstallPack,
  getInstallProgress,
  listActiveTasks,
  downloadPackModelTask,
  removePackModel,
} from '../services/packs/install.js';
import { getPackSettingsView, applyPackSettingsPatch } from '../services/packs/settings.js';
import {
  PackListResponseSchema,
  PackParamsSchema,
  PackTaskStartedSchema,
  PackTaskParamsSchema,
  PackTaskProgressSchema,
  PackTaskListResponseSchema,
  PackSettingsResponseSchema,
  PackSettingsPatchBodySchema,
  PackModelParamsSchema,
  PackModelDownloadResponseSchema,
  PackModelRemoveResponseSchema,
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

const tasksRoute = defineRoute({
  method: 'GET',
  path: '/packs/tasks',
  response: PackTaskListResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['packs'],
  summary: 'List every in-flight (or just-completed) pack install/uninstall task — mount-time reconciliation for Packs.tsx',
}, (ctx) => ctx.ok({ items: listActiveTasks() }));

const getSettingsRoute = defineRoute({
  method: 'GET',
  path: '/packs/:id/settings',
  params: PackParamsSchema,
  response: PackSettingsResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['packs'],
  summary: 'Get a pack\'s model catalog + settings (registry merged with DB deviations)',
}, (ctx) => {
  if (!isPackId(ctx.params.id)) throw new NotFoundError(`Unknown pack: ${ctx.params.id}`);
  return ctx.ok(getPackSettingsView(ctx.params.id));
});

const patchSettingsRoute = defineRoute({
  method: 'PATCH',
  path: '/packs/:id/settings',
  params: PackParamsSchema,
  body: PackSettingsPatchBodySchema,
  response: PackSettingsResponseSchema,
  auth: { required: true, scopes: ['packs:install'] },
  tags: ['packs'],
  summary: 'Update model selection / repo overrides / settings for a pack',
}, (ctx) => {
  if (!isPackId(ctx.params.id)) throw new NotFoundError(`Unknown pack: ${ctx.params.id}`);
  // Every modelId in the patch is validated against the registry BEFORE any
  // DB write — never let an arbitrary client-supplied id reach a DB row or,
  // downstream (via `resolvePackModelDest`'s repo_override handling), a
  // filesystem path. `applyPackSettingsPatch` re-checks this too (defence in
  // depth), but validating here first gives a clean 400 instead of a 500 for
  // a typo'd model id.
  for (const modelId of Object.keys(ctx.body.models ?? {})) {
    if (!getPackModel(ctx.params.id, modelId)) {
      throw new ValidationError(`Unknown model for pack ${ctx.params.id}: ${modelId}`);
    }
  }
  applyPackSettingsPatch(ctx.params.id, ctx.body);
  return ctx.ok(getPackSettingsView(ctx.params.id));
});

const downloadModelRoute = defineRoute({
  method: 'POST',
  path: '/packs/:id/models/:modelId/download',
  params: PackModelParamsSchema,
  response: PackModelDownloadResponseSchema,
  auth: { required: true, scopes: ['packs:install'] },
  tags: ['packs'],
  summary: 'Download one pack model now, fire-and-forget',
}, (ctx) => {
  if (!isPackId(ctx.params.id)) throw new NotFoundError(`Unknown pack: ${ctx.params.id}`);
  if (!getPackModel(ctx.params.id, ctx.params.modelId)) {
    throw new NotFoundError(`Unknown model: ${ctx.params.modelId}`);
  }
  const taskId = downloadPackModelTask(ctx.params.id, ctx.params.modelId);
  return ctx.ok({ taskId });
});

const removeModelRoute = defineRoute({
  method: 'DELETE',
  path: '/packs/:id/models/:modelId',
  params: PackModelParamsSchema,
  response: PackModelRemoveResponseSchema,
  auth: { required: true, scopes: ['packs:install'] },
  tags: ['packs'],
  summary: 'Delete a downloaded pack model from disk and mark it absent',
}, (ctx) => {
  if (!isPackId(ctx.params.id)) throw new NotFoundError(`Unknown pack: ${ctx.params.id}`);
  if (!getPackModel(ctx.params.id, ctx.params.modelId)) {
    throw new NotFoundError(`Unknown model: ${ctx.params.modelId}`);
  }
  return ctx.ok(removePackModel(ctx.params.id, ctx.params.modelId));
});

const router = Router();
[
  listRoute,
  installRoute,
  uninstallRoute,
  progressRoute,
  tasksRoute,
  getSettingsRoute,
  patchSettingsRoute,
  downloadModelRoute,
  removeModelRoute,
].forEach((r) => r.register(router));

export default router;
