// ACE-Step LoRA control routes. Ported from ace-step-ui's
// `server/src/routes/lora.ts`.
//
// These hit the resident ACE-Step FastAPI (`services/ace/acestep.ts`'s
// `loadLora`/`unloadLora`/`setLoraScale`/`toggleLora`/`getLoraStatus`), so
// every call is wrapped in `submitGpuJob('ace-step-generate', ...)` — the
// same tenant/task-type `routes/ace/generate.routes.ts` uses — which both
// ensures ACE-Step is resident (`ensureResident('ace-step')`, spawning it if
// needed) and serializes against a concurrent generation request.

import { Router } from 'express';
import path from 'path';
import { existsSync } from 'fs';
import { defineRoute } from '../../lib/defineRoute.js';
import { submitGpuJob } from '../../services/gpu/scheduler.js';
import * as aceStep from '../../services/ace/acestep.js';
import {
  LoraLoadBodySchema,
  LoraLoadResponseSchema,
  LoraUnloadResponseSchema,
  LoraScaleBodySchema,
  LoraScaleResponseSchema,
  LoraToggleBodySchema,
  LoraToggleResponseSchema,
  LoraStatusResponseSchema,
} from '../../contracts/ace/lora.contract.js';

const router = Router();

// ACE-Step expects `lora_path` to be a PEFT LoRA directory containing
// adapter_config.json directly. Callers sometimes pass the training root or
// its `final` dir instead of the actual adapter dir (the trainer saves to
// `<output_dir>/final/adapter` — see `routes/ace/training.routes.ts`'s
// `resolveFinalCheckpointDir`). Resolve defensively; fall back to the
// original path if nothing matches.
function resolveAdapterPath(loraPath: string): string {
  if (existsSync(path.join(loraPath, 'adapter_config.json'))) {
    return loraPath;
  }
  const candidates = [
    path.join(loraPath, 'final', 'adapter'),
    path.join(loraPath, 'adapter'),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'adapter_config.json'))) {
      return candidate;
    }
  }
  return loraPath;
}

const loadRoute = defineRoute({
  method: 'POST',
  path: '/ace/lora/load',
  body: LoraLoadBodySchema,
  response: LoraLoadResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Load a LoRA adapter into the resident ACE-Step FastAPI',
}, async ({ body, ok }) => {
  const resolvedPath = resolveAdapterPath(body.lora_path);
  const message = await submitGpuJob('ace-step-generate', async (release) => {
    try {
      return await aceStep.loadLora(resolvedPath, body.adapter_name);
    } finally {
      release();
    }
  });
  return ok({ message, lora_path: resolvedPath, loaded: true });
});

const unloadRoute = defineRoute({
  method: 'POST',
  path: '/ace/lora/unload',
  response: LoraUnloadResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Unload the currently active LoRA adapter',
}, async ({ ok }) => {
  const message = await submitGpuJob('ace-step-generate', async (release) => {
    try {
      return await aceStep.unloadLora();
    } finally {
      release();
    }
  });
  return ok({ message });
});

const scaleRoute = defineRoute({
  method: 'POST',
  path: '/ace/lora/scale',
  body: LoraScaleBodySchema,
  response: LoraScaleResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Set the active LoRA adapter\'s strength (0-1)',
}, async ({ body, ok }) => {
  const message = await submitGpuJob('ace-step-generate', async (release) => {
    try {
      return await aceStep.setLoraScale(body.scale, body.adapter_name);
    } finally {
      release();
    }
  });
  return ok({ message, scale: body.scale });
});

const toggleRoute = defineRoute({
  method: 'POST',
  path: '/ace/lora/toggle',
  body: LoraToggleBodySchema,
  response: LoraToggleResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['ace'],
  summary: 'Enable/disable the loaded LoRA adapter without unloading it',
}, async ({ body, ok }) => {
  const message = await submitGpuJob('ace-step-generate', async (release) => {
    try {
      return await aceStep.toggleLora(body.enabled);
    } finally {
      release();
    }
  });
  return ok({ message, active: body.enabled });
});

const statusRoute = defineRoute({
  method: 'GET',
  path: '/ace/lora/status',
  response: LoraStatusResponseSchema,
  auth: { required: true, scopes: ['system:read'] },
  tags: ['ace'],
  summary: 'Get the current LoRA adapter load/active/scale state',
}, async ({ ok }) => {
  try {
    const status = await submitGpuJob('ace-step-generate', async (release) => {
      try {
        return await aceStep.getLoraStatus();
      } finally {
        release();
      }
    });
    const data = (status as { data?: Record<string, unknown> } | null)?.data ?? status ?? {};
    return ok({
      loaded: Boolean((data as Record<string, unknown>).loaded),
      active: Boolean((data as Record<string, unknown>).active),
      scale: Number((data as Record<string, unknown>).scale ?? 1.0),
    });
  } catch {
    return ok({ loaded: false, active: false, scale: 1.0 });
  }
});

[loadRoute, unloadRoute, scaleRoute, toggleRoute, statusRoute].forEach((r) => r.register(router));

export default router;
