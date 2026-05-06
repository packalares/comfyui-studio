// Generate endpoint — inline pipeline (legacy, pre-1b9f77b shape).
//
// The earlier refactor routed `/api/generate` through `submitTemplate`, but
// that path enforces a chat-tool input contract (zod schema with required
// `prompt` key) which rejected legitimate UI submissions that use raw widget
// keys (`text`, `image`, `audio`, etc.). This handler restores the legacy
// pass-through behavior. Chat-tool callers (generate_image / submitGeneration
// MCP tool) continue to use `submitTemplate` directly.

import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';
import * as templates from '../services/templates/index.js';
import { generateFormInputs } from '../services/templates/templates.formInputs.js';
import type { RawTemplate } from '../services/templates/types.js';
import { getObjectInfo, workflowToApiPrompt } from '../services/workflow/index.js';
import { schedulePromptWatch } from '../services/gallery.sentry.js';
import { insertSnapshot } from '../lib/db/promptSnapshots.repo.js';
import { computeModelFingerprint } from '../services/templates/submitTemplate.js';
import {
  applyNodeOverrides,
  applyProxyOverrides,
  splitAdvancedSettings,
} from '../services/templates/advancedSettings.js';
import { env } from '../config/env.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';

const router = Router();

const generateLimiter = rateLimit({ windowMs: 60_000, max: 60 });

interface NodeErrorRow {
  nodeId: string;
  classType?: string;
  message: string;
  details?: string;
}

function parseComfyValidation(body: string): {
  summary: string;
  nodeErrors: NodeErrorRow[];
} | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as {
    error?: { message?: string; type?: string };
    node_errors?: Record<string, {
      errors?: Array<{ message?: string; details?: string; type?: string }>;
      class_type?: string;
    }>;
  };
  const summary = p.error?.message || p.error?.type || 'Workflow validation failed';
  const nodeErrors: NodeErrorRow[] = [];
  if (p.node_errors && typeof p.node_errors === 'object') {
    for (const [nodeId, info] of Object.entries(p.node_errors)) {
      const classType = info?.class_type;
      for (const e of info?.errors ?? []) {
        nodeErrors.push({
          nodeId,
          classType,
          message: e?.message || e?.type || 'Invalid input',
          details: e?.details,
        });
      }
    }
  }
  if (nodeErrors.length === 0 && !p.error) return null;
  return { summary, nodeErrors };
}

router.post('/generate', generateLimiter, async (req: Request, res: Response) => {
  try {
    const { templateName, inputs: userInputs, advancedSettings } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }

    let workflow: Record<string, unknown>;
    if (templates.isUserWorkflow(templateName)) {
      const local = templates.getUserWorkflowJson(templateName);
      if (!local) {
        res.status(404).json({ error: 'User workflow file missing or unreadable' });
        return;
      }
      workflow = local;
    } else {
      const wfRes = await fetch(
        `${env.COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`,
      );
      if (!wfRes.ok) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      workflow = await wfRes.json() as Record<string, unknown>;
    }

    // Hash the workflow BEFORE any overrides so identical templates with
    // different widget values share the same hash (used for "show me all
    // gallery items rendered from this workflow" queries).
    const templateHash = createHash('sha1')
      .update(JSON.stringify(workflow))
      .digest('hex')
      .slice(0, 16);

    const { proxyEntries, nodeOverrides } = splitAdvancedSettings(advancedSettings);
    applyProxyOverrides(workflow, proxyEntries);

    const template = templates.getTemplate(templateName);
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

    const apiPrompt = await workflowToApiPrompt(
      workflow,
      userInputs || {},
      mergedFormInputs,
    );
    applyNodeOverrides(apiPrompt, nodeOverrides);

    const attachApiKey = template?.openSource === false;
    const result = await comfyui.submitPrompt(apiPrompt, { attachApiKey });
    if (result?.prompt_id) {
      // Snapshot for race-recovery: gallery hydration falls back to this
      // row if the WS event path misses execution_success.
      try {
        insertSnapshot({
          promptId: result.prompt_id,
          apiPromptJson: JSON.stringify(apiPrompt),
          templateName,
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
    res.json(result);
  } catch (err) {
    if (err instanceof comfyui.ComfyUIHttpError) {
      const parsed = parseComfyValidation(err.body);
      if (parsed && err.status >= 400 && err.status < 500) {
        res.status(400).json({
          error: parsed.summary,
          nodeErrors: parsed.nodeErrors,
          upstreamStatus: err.status,
        });
        return;
      }
      res.status(502).json({
        error: 'ComfyUI rejected the prompt',
        detail: err.body.slice(0, 500) || err.message,
        upstreamStatus: err.status,
      });
      return;
    }
    sendError(res, err, 500, 'Generation failed');
  }
});

export default router;
