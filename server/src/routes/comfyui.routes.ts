// ComfyUI lifecycle routes: start / stop / restart / logs / reset / launch-options.

import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError } from '../lib/errors.js';
import { getProcessService } from '../services/comfyui/process.js';
import {
  getLaunchCommandView,
  resetToDefault,
  updateLaunchOptions,
} from '../services/comfyui/launchOptions.js';

// ---- Shared schemas ----

// Use z.unknown() for lifecycle results — process service returns typed structs
// that vary per action; we forward verbatim without re-validating on the way out.
const LifecycleResultSchema = z.unknown();

const LaunchCommandViewSchema = z.object({
  mode: z.enum(['list', 'manual']),
  items: z.array(z.unknown()),
  manualArgs: z.string(),
  baseCommand: z.string(),
  fixedArgs: z.array(z.string()),
  extraArgs: z.array(z.string()),
  fullCommandLine: z.string(),
});

// ---- Lifecycle ----

const startRoute = defineRoute({
  method: 'POST',
  path: '/start',
  response: LifecycleResultSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['comfyui'],
  summary: 'Start ComfyUI process',
}, async ({ ok }) => {
  const result = await getProcessService().startComfyUI();
  return ok(result);
});

const stopRoute = defineRoute({
  method: 'POST',
  path: '/stop',
  response: LifecycleResultSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['comfyui'],
  summary: 'Stop ComfyUI process',
}, async ({ ok }) => {
  const result = await getProcessService().stopComfyUI();
  return ok(result);
});

const restartRoute = defineRoute({
  method: 'POST',
  path: '/restart',
  response: LifecycleResultSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['comfyui'],
  summary: 'Restart ComfyUI process',
}, async ({ ok }) => {
  const result = await getProcessService().restartComfyUI();
  return ok(result);
});

// ---- Logs ----

const logsRoute = defineRoute({
  method: 'GET',
  path: '/comfyui/logs',
  response: z.object({ logs: z.array(z.string()) }),
  auth: { required: true, scopes: ['system:read'] },
  tags: ['comfyui'],
  summary: 'Get recent ComfyUI stdout/stderr logs',
}, ({ ok }) => {
  const logs = getProcessService().getLogStore().getRecentLogs();
  return ok({ logs });
});

// ---- Reset ----

const resetRoute = defineRoute({
  method: 'POST',
  path: '/comfyui/reset',
  body: z.object({ mode: z.enum(['normal', 'hard']).default('normal') }),
  response: LifecycleResultSchema,
  auth: { required: true, scopes: ['models:write'] },
  tags: ['comfyui'],
  summary: 'Reset ComfyUI (clear temp files, optionally nuke venv)',
}, async ({ body, ok }) => {
  const result = await getProcessService().resetComfyUI(body.mode);
  return ok(result);
});

const resetLogsRoute = defineRoute({
  method: 'GET',
  path: '/comfyui/reset-logs',
  response: z.object({
    logs: z.array(z.string()),
    success: z.boolean(),
    message: z.string(),
  }),
  auth: { required: true, scopes: ['system:read'] },
  tags: ['comfyui'],
  summary: 'Get logs from the last ComfyUI reset',
}, ({ ok }) => {
  const logs = getProcessService().getLogStore().getResetLogs();
  const message = logs.length === 0
    ? 'No reset logs found'
    : `Retrieved ${logs.length} reset log entries`;
  return ok({ logs, success: true, message });
});

// ---- Launch options ----

const getLaunchOptionsRoute = defineRoute({
  method: 'GET',
  path: '/comfyui/launch-options',
  response: LaunchCommandViewSchema,
  auth: { required: true, scopes: ['settings:read'] },
  tags: ['comfyui'],
  summary: 'Get current ComfyUI launch options',
}, ({ ok }) => ok(getLaunchCommandView()));

const putLaunchOptionsRoute = defineRoute({
  method: 'PUT',
  path: '/comfyui/launch-options',
  body: z.record(z.string(), z.unknown()),
  response: LaunchCommandViewSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['comfyui'],
  summary: 'Update ComfyUI launch options',
}, ({ body, ok }) => {
  updateLaunchOptions(body as Parameters<typeof updateLaunchOptions>[0]);
  return ok(getLaunchCommandView());
});

const resetLaunchOptionsRoute = defineRoute({
  method: 'POST',
  path: '/comfyui/launch-options/reset',
  response: LaunchCommandViewSchema,
  auth: { required: true, scopes: ['settings:write'] },
  tags: ['comfyui'],
  summary: 'Reset ComfyUI launch options to defaults',
}, ({ ok }) => {
  resetToDefault();
  return ok(getLaunchCommandView());
});

const router = Router();
startRoute.register(router);
stopRoute.register(router);
restartRoute.register(router);
logsRoute.register(router);
resetRoute.register(router);
resetLogsRoute.register(router);
getLaunchOptionsRoute.register(router);
putLaunchOptionsRoute.register(router);
resetLaunchOptionsRoute.register(router);

export default router;
