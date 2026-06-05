// POST /api/generate — inline pipeline submit. Translates form inputs into a
// ComfyUI API-format prompt and submits it. Chat-tool callers use submitTemplate
// directly; this route is the UI's direct submit path (widget keys like `text`,
// `image`, `audio` rather than the chat contract's `prompt`).

import { createHash } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { defineRoute } from '../lib/defineRoute.js';
import { NotFoundError, ValidationError, UpstreamUnavailableError } from '../lib/errors.js';
import * as comfyui from '../services/comfyui/api.js';
import * as templates from '../services/templates/index.js';
import { generateFormInputs } from '../services/templates/templates.formInputs.js';
import type { RawTemplate } from '../services/templates/types.js';
import { getObjectInfo, workflowToApiPrompt } from '../services/workflow/index.js';
import { schedulePromptWatch } from '../services/gallery/sentry.js';
import { insertSnapshot } from '../lib/db/promptSnapshots.repo.js';
import { computeModelFingerprint } from '../services/templates/submitTemplate.js';
import {
  applyNodeOverrides,
  applyProxyOverrides,
  splitAdvancedSettings,
} from '../services/templates/advancedSettings.js';
import { getBridgeClientId, trackComfyPrompt } from '../services/videoboard/comfyJobBridge.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { GenerateBodySchema, GenerateResponseSchema } from '../contracts/generate.contract.js';
import { submitGpuJob } from '../services/gpu/scheduler.js';

const generateLimiter = rateLimit({ windowMs: 60_000, max: 60 });

interface NodeErrorRow { nodeId: string; classType?: string; message: string; details?: string; }

function parseComfyValidation(body: string): { summary: string; nodeErrors: NodeErrorRow[] } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as {
    error?: { message?: string; type?: string };
    node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string; type?: string }>; class_type?: string }>;
  };
  const summary = p.error?.message || p.error?.type || 'Workflow validation failed';
  const nodeErrors: NodeErrorRow[] = [];
  if (p.node_errors) {
    for (const [nodeId, info] of Object.entries(p.node_errors)) {
      for (const e of info?.errors ?? []) {
        nodeErrors.push({ nodeId, classType: info?.class_type, message: e?.message || e?.type || 'Invalid input', details: e?.details });
      }
    }
  }
  if (nodeErrors.length === 0 && !p.error) return null;
  return { summary, nodeErrors };
}

const generateRoute = defineRoute({
  method: 'POST',
  path: '/generate',
  body: GenerateBodySchema,
  response: GenerateResponseSchema,
  auth: { required: true, scopes: ['generate:write'] },
  tags: ['generate'],
  summary: 'Submit a workflow prompt to ComfyUI',
}, async ({ body, ok }) => {
  const { templateName, inputs: userInputs, advancedSettings } = body;

  const workflow = templates.getUserWorkflowJson(templateName);
  if (!workflow) throw new NotFoundError('Workflow file missing or unreadable');

  const templateHash = createHash('sha1')
    .update(JSON.stringify(workflow))
    .digest('hex')
    .slice(0, 16);

  const { proxyEntries, nodeOverrides } = splitAdvancedSettings(advancedSettings);
  applyProxyOverrides(workflow, proxyEntries);

  const template = templates.getUserTemplate(templateName);
  const objectInfo = await getObjectInfo();
  const rawForBindings: RawTemplate = {
    name: templateName,
    title: template?.title ?? templateName,
    description: template?.description ?? '',
    mediaType: template?.mediaType ?? 'image',
    tags: template?.tags ?? [],
    models: template?.models ?? [],
    io: template?.io,
  };
  const mergedFormInputs = generateFormInputs(rawForBindings, workflow, objectInfo);
  const apiPrompt = await workflowToApiPrompt(workflow, userInputs, mergedFormInputs);
  applyNodeOverrides(apiPrompt, nodeOverrides);

  const attachApiKey = template?.openSource === false;

  // Wrap the ComfyUI submission in the GPU scheduler slot.
  // Slot is held from POST to comfyui until execution_success/error/cancelled fires
  // (or a 30-min timeout). The bridge subscription is per-job and unsubscribes in finally.
  let result: Awaited<ReturnType<typeof comfyui.submitPrompt>>;
  try {
    result = await submitGpuJob('comfy-generate', async (release) => {
      let submitResult: Awaited<ReturnType<typeof comfyui.submitPrompt>>;
      try {
        submitResult = await comfyui.submitPrompt(apiPrompt, { attachApiKey, clientId: getBridgeClientId() });
      } catch (err) {
        release();
        throw err;
      }
      // Track until ComfyUI fires a terminal event, then release the slot.
      // Errors from trackComfyPrompt (cancelled / interrupted) are absorbed
      // because the UI already got its prompt_id — no need to propagate.
      if (submitResult?.prompt_id) {
        trackComfyPrompt(submitResult.prompt_id, { timeoutMs: 30 * 60 * 1000 })
          .catch(() => { /* terminal event: job done one way or another */ })
          .finally(() => release());
      } else {
        release();
      }
      return submitResult;
    });
  } catch (err) {
    if (err instanceof comfyui.ComfyUIHttpError) {
      const parsed = parseComfyValidation(err.body);
      if (parsed && err.status >= 400 && err.status < 500) {
        throw new ValidationError(parsed.summary, { nodeErrors: parsed.nodeErrors, upstreamStatus: err.status });
      }
      throw new UpstreamUnavailableError('ComfyUI rejected the prompt', {
        detail: err.body.slice(0, 500) || err.message,
        upstreamStatus: err.status,
      });
    }
    throw err;
  }

  if (result?.prompt_id) {
    try {
      insertSnapshot({
        promptId: result.prompt_id,
        apiPromptJson: JSON.stringify(apiPrompt),
        templateName,
        triggered_by: 'ui',
        conversation_id: null,
        message_id: null,
      });
    } catch { /* snapshot failure must not fail the submit */ }

    const modelFingerprint = computeModelFingerprint(
      template?.models?.map(m =>
        typeof m === 'string' ? m : (m as { filename?: string }).filename ?? '',
      ).filter(Boolean) ?? [],
    );
    schedulePromptWatch(result.prompt_id, {
      triggeredBy: 'ui',
      conversationId: null,
      messageId: null,
      modelFingerprint,
      templateHash,
    });
  }

  // Wrap ComfyUI's response: rename prompt_id → promptId at the top level
  // and preserve all other fields verbatim.
  const { prompt_id, ...rest } = result ?? {};
  return ok({ promptId: prompt_id ?? '', ...rest });
});

const router = Router();
router.use(generateLimiter);
generateRoute.register(router);

export default router;
