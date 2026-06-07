// Python / pip routes.
//   GET  /python/pip-source
//   POST /python/pip-source
//   GET  /python/packages
//   POST /python/packages/install
//   POST /python/packages/uninstall
//   GET  /python/plugins/dependencies
//   POST /python/plugins/fix-dependencies

import { Router } from 'express';
import * as pipSource from '../services/python/pipSource.service.js';
import * as packages from '../services/python/packages.service.js';
import * as deps from '../services/python/dependencies.service.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { defineRoute } from '../lib/defineRoute.js';
import { ValidationError, HttpError } from '../lib/errors.js';
import {
  PipSourceBodySchema,
  PackageInstallBodySchema,
  FixDepsBodySchema,
  PipSourceResponseSchema,
  InstalledPackageSchema,
  PackageOpResponseSchema,
  PluginDependencyReportSchema,
  FixDepsResponseSchema,
} from '../contracts/python.contract.js';
import { z } from 'zod';

// Package install/uninstall invoke pip — 10/min is plenty for interactive use.
const pkgLimiter = rateLimit('python:pkg');

// ---- Routes ----

const getPipSourceRoute = defineRoute({
  method: 'GET',
  path: '/python/pip-source',
  response: PipSourceResponseSchema,
  auth: { required: true, scopes: ['settings:read'] },
  tags: ['python'],
  summary: 'Get configured pip index-url',
}, (ctx) => {
  return ctx.ok({ source: pipSource.getPipSource() });
});

const setPipSourceRoute = defineRoute({
  method: 'POST',
  path: '/python/pip-source',
  body: PipSourceBodySchema,
  response: PipSourceResponseSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['python'],
  summary: 'Set pip index-url',
}, (ctx) => {
  try {
    pipSource.setPipSource(ctx.body.source);
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : String(err));
  }
  return ctx.ok({ source: ctx.body.source });
});

const listPackagesRoute = defineRoute({
  method: 'GET',
  path: '/python/packages',
  response: z.array(InstalledPackageSchema),
  auth: { required: true, scopes: ['settings:read'] },
  tags: ['python'],
  summary: 'List installed pip packages',
}, async (ctx) => {
  const list = await packages.listInstalledPackages();
  return ctx.ok(list);
});

const installPackageRoute = defineRoute({
  method: 'POST',
  path: '/python/packages/install',
  body: PackageInstallBodySchema,
  response: PackageOpResponseSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['python'],
  summary: 'Install a pip package',
}, async (ctx) => {
  try {
    const r = await packages.installPackage(ctx.body.package);
    return ctx.ok({ success: true, message: 'Install succeeded', output: r.output });
  } catch (err) {
    throw new HttpError('internal_error', `Install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

const uninstallPackageRoute = defineRoute({
  method: 'POST',
  path: '/python/packages/uninstall',
  body: PackageInstallBodySchema,
  response: PackageOpResponseSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['python'],
  summary: 'Uninstall a pip package',
}, async (ctx) => {
  try {
    const r = await packages.uninstallPackage(ctx.body.package);
    return ctx.ok({ success: true, message: 'Uninstall succeeded', output: r.output });
  } catch (err) {
    throw new HttpError('internal_error', `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

const pluginDepsRoute = defineRoute({
  method: 'GET',
  path: '/python/plugins/dependencies',
  response: z.array(PluginDependencyReportSchema),
  auth: { required: true, scopes: ['settings:read'] },
  tags: ['python'],
  summary: 'Per-plugin dependency report',
}, async (ctx) => {
  const r = await deps.analyzePluginDependencies();
  return ctx.ok(r);
});

const fixDepsRoute = defineRoute({
  method: 'POST',
  path: '/python/plugins/fix-dependencies',
  body: FixDepsBodySchema,
  response: FixDepsResponseSchema,
  auth: { required: true, scopes: ['models:install'] },
  tags: ['python'],
  summary: 'pip install -r requirements.txt for one plugin',
}, async (ctx) => {
  try {
    const r = await deps.fixPluginDependencies(ctx.body.plugin);
    return ctx.ok({ success: true, message: 'Dependencies fixed', output: r.output });
  } catch (err) {
    throw new HttpError('internal_error', `Dependency fix failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---- Mount ----
const router = Router();

[getPipSourceRoute, listPackagesRoute, pluginDepsRoute].forEach(r => r.register(router));

// Write routes get rate-limiter injected.
const writeLimited = (r: ReturnType<typeof defineRoute>) => {
  const method = r.spec.method.toLowerCase() as 'post' | 'put' | 'patch' | 'delete';
  router[method](r.spec.path, pkgLimiter, (req, res, next) => {
    const mini = Router();
    r.register(mini);
    mini(req, res, next);
  });
};

[setPipSourceRoute, installPackageRoute, uninstallPackageRoute, fixDepsRoute].forEach(writeLimited);

export default router;
