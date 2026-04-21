// Generate endpoint — converts a template's UI-format workflow to ComfyUI's
// API prompt format, applies advanced-setting overrides, and submits the
// prompt. API-node workflows (openSource === false) get the Comfy Org API
// key attached via the service layer.

import { Router, type Request, type Response } from 'express';
import * as comfyui from '../services/comfyui.js';
import * as templates from '../services/templates/index.js';
import { workflowToApiPrompt } from '../services/workflow/index.js';
import { schedulePromptWatch } from '../services/gallery.sentry.js';
import { env } from '../config/env.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errors.js';

const COMFYUI_URL = env.COMFYUI_URL;

const router = Router();

// 60 req/min per IP. Guards against a page bug spamming the generate endpoint
// or a cheap DoS saturating the GPU queue.
const generateLimiter = rateLimit({ windowMs: 60_000, max: 60 });

interface AdvancedSettingValue { proxyIndex: number; value: unknown }

interface SplitOverrides {
  proxyEntries: Array<{ proxyIndex: number; value: unknown }>;
  nodeOverrides: Record<string, Record<string, unknown>>;
}

// Split advancedSettings into proxy-widget overrides (mutated onto the wrapper
// node's widgets_values) and raw-node overrides (applied post-conversion onto
// the API prompt directly).
function splitAdvancedSettings(advancedSettings: unknown): SplitOverrides {
  const proxyEntries: Array<{ proxyIndex: number; value: unknown }> = [];
  const nodeOverrides: Record<string, Record<string, unknown>> = {};
  if (!advancedSettings || typeof advancedSettings !== 'object') {
    return { proxyEntries, nodeOverrides };
  }
  for (const [id, val] of Object.entries(advancedSettings as Record<string, AdvancedSettingValue>)) {
    if (!val || typeof val !== 'object') continue;
    if (typeof val.proxyIndex === 'number' && val.proxyIndex >= 0) {
      proxyEntries.push(val);
      continue;
    }
    if (id.startsWith('node:')) {
      const parts = id.split(':');
      if (parts.length < 3) continue;
      const nodeId = parts[1];
      const widgetName = parts.slice(2).join(':');
      if (!nodeOverrides[nodeId]) nodeOverrides[nodeId] = {};
      nodeOverrides[nodeId][widgetName] = val.value;
    }
  }
  return { proxyEntries, nodeOverrides };
}

// Mutate the wrapper node's widgets_values in-place so downstream flattening
// picks up the user's proxy-widget values.
function applyProxyOverrides(
  workflow: Record<string, unknown>,
  proxyEntries: Array<{ proxyIndex: number; value: unknown }>,
): void {
  if (proxyEntries.length === 0) return;
  const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  for (const node of topNodes) {
    const props = node.properties as Record<string, unknown> | undefined;
    if (!(props?.proxyWidgets && Array.isArray(props.proxyWidgets))) continue;
    const wv = (node.widgets_values || []) as unknown[];
    for (const val of proxyEntries) {
      if (val.proxyIndex < wv.length) wv[val.proxyIndex] = val.value;
    }
    node.widgets_values = wv;
    break;
  }
}

// Apply raw-node widget overrides post-conversion. User-chosen values win over
// workflowToApiPrompt's auto-randomized seed when targeting a seed widget.
function applyNodeOverrides(
  apiPrompt: Record<string, { inputs?: Record<string, unknown> }>,
  nodeOverrides: Record<string, Record<string, unknown>>,
): void {
  for (const [nodeId, overrides] of Object.entries(nodeOverrides)) {
    const entry = apiPrompt[nodeId];
    if (!entry?.inputs) continue;
    for (const [widgetName, value] of Object.entries(overrides)) {
      entry.inputs[widgetName] = value;
    }
  }
}

router.post('/generate', generateLimiter, async (req: Request, res: Response) => {
  try {
    const { templateName, inputs: userInputs, advancedSettings } = req.body;
    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' });
      return;
    }

    // 1. Fetch the workflow JSON. User-imported templates live only on our
    //    disk (ComfyUI doesn't know about them) so resolve those locally
    //    first; everything else comes from ComfyUI's templates dir.
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
        `${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`
      );
      if (!wfRes.ok) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      workflow = await wfRes.json() as Record<string, unknown>;
    }

    // 2. Split + apply proxy-widget overrides (before conversion).
    const { proxyEntries, nodeOverrides } = splitAdvancedSettings(advancedSettings);
    applyProxyOverrides(workflow, proxyEntries);

    // 3. Convert to API prompt format with user inputs injected, using the template's
    //    own formInputs bindings so each user value lands on the node the template declared.
    const template = templates.getTemplate(templateName);
    const apiPrompt = await workflowToApiPrompt(
      workflow,
      userInputs || {},
      template?.formInputs || [],
    );

    // 3b. Apply raw-node overrides onto the API prompt.
    applyNodeOverrides(apiPrompt, nodeOverrides);

    // 4. Submit to ComfyUI — attach Comfy Org API key only for API-node workflows.
    const attachApiKey = template?.openSource === false;
    const result = await comfyui.submitPrompt(apiPrompt, { attachApiKey });
    // Belt-and-suspenders: history poller recovers if the WS event path
    // misses `execution_success` (ComfyUI restart, WS reconnecting, etc).
    if (result?.prompt_id) schedulePromptWatch(result.prompt_id);
    res.json(result);
  } catch (err) {
    sendError(res, err, 500, 'Generation failed');
  }
});

export default router;
