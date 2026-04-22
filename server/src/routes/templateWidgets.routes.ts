// Template widget routes: enumerate raw-node widgets the user can expose,
// persist their selection, and return the merged Advanced Settings list
// (proxy-widget entries + user-exposed raw-node entries).

import { Router, type Request, type Response } from 'express';
import * as exposedWidgets from '../services/exposedWidgets.js';
import * as templates from '../services/templates/index.js';
import {
  buildRawWidgetSettings,
  enumerateTemplateWidgets,
  extractAdvancedSettings,
  extractPrimitiveFormFields,
  getObjectInfo,
  resolveProxyLabels,
  workflowToApiPrompt,
} from '../services/workflow/index.js';
import { env } from '../config/env.js';
import { sendError } from '../middleware/errors.js';
import type { AdvancedSetting } from '../contracts/workflow.contract.js';

const COMFYUI_URL = env.COMFYUI_URL;

/**
 * Load a workflow JSON by template name. User-imported templates live on our
 * disk (ComfyUI doesn't know about them) so check locally first; fall back to
 * ComfyUI's `/templates/:name.json` for upstream templates.
 */
async function loadWorkflowJson(templateName: string): Promise<Record<string, unknown> | null> {
  if (templates.isUserWorkflow(templateName)) {
    return templates.getUserWorkflowJson(templateName);
  }
  const wfRes = await fetch(`${COMFYUI_URL}/templates/${encodeURIComponent(templateName)}.json`);
  if (!wfRes.ok) return null;
  return await wfRes.json() as Record<string, unknown>;
}

const router = Router();

interface WrapperMatch {
  wrapperNode: Record<string, unknown> | null;
  proxyWidgets: string[][] | null;
  widgetValues: unknown[];
}

// Locate the top-level wrapper node carrying a `proxyWidgets` property. Only
// authored-wrapper templates have one; raw-widget templates return all-nulls.
function findWrapperNode(workflow: Record<string, unknown>): WrapperMatch {
  const topNodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  for (const node of topNodes) {
    const props = node.properties as Record<string, unknown> | undefined;
    if (props?.proxyWidgets && Array.isArray(props.proxyWidgets)) {
      return {
        wrapperNode: node,
        proxyWidgets: props.proxyWidgets as string[][],
        widgetValues: (node.widgets_values || []) as unknown[],
      };
    }
  }
  return { wrapperNode: null, proxyWidgets: null, widgetValues: [] };
}

router.get('/workflow-settings/:templateName', async (req: Request, res: Response) => {
  try {
    const templateName = req.params.templateName as string;
    const workflow = await loadWorkflowJson(templateName);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    // Proxy-widget path: only runs when the template has a wrapper node authored with proxyWidgets.
    // Raw-widget path (user-picked fields) runs regardless, so templates without a wrapper still
    // surface whatever the user opted to expose via the "Edit advanced fields" modal.
    const { wrapperNode, proxyWidgets, widgetValues } = findWrapperNode(workflow);
    const objectInfo = await getObjectInfo();
    let settings: AdvancedSetting[] = [];
    if (wrapperNode && proxyWidgets && proxyWidgets.length > 0) {
      const labels = resolveProxyLabels(wrapperNode, proxyWidgets, workflow);
      settings = extractAdvancedSettings(proxyWidgets, widgetValues, objectInfo, labels);
    }

    const userExposed = exposedWidgets.getForTemplate(templateName);
    if (userExposed.length > 0) {
      const rawSettings = buildRawWidgetSettings(workflow, userExposed, objectInfo, templateName);
      settings.push(...rawSettings);
    }

    res.json({ settings });
  } catch (err) {
    sendError(res, err, 500, 'Failed to extract workflow settings');
  }
});

// List every editable widget in a template's workflow, each tagged with whether it's currently exposed.
// Also returns `primitiveFormFields` — FormInputData entries derived from titled subgraph
// Primitive* nodes (ComfyUI 0.3.51+ subgraph workflows encode their Prompt/Width/Height/etc.
// as PrimitiveStringMultiline/PrimitiveInt nodes inside `definitions.subgraphs`). Studio merges
// these into the template form so the user can edit them directly.
router.get('/template-widgets/:templateName', async (req: Request, res: Response) => {
  try {
    const templateName = req.params.templateName as string;
    const workflow = await loadWorkflowJson(templateName);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const widgets = await enumerateTemplateWidgets(workflow, templateName);
    const primitiveFormFields = extractPrimitiveFormFields(workflow);
    res.json({ widgets, primitiveFormFields });
  } catch (err) {
    sendError(res, err, 500, 'Failed to enumerate template widgets');
  }
});

/**
 * Debug/compare endpoint: convert a template's workflow to ComfyUI's API
 * prompt format (what would be sent to `/api/prompt` if the user clicked
 * Generate with defaults). Useful for validating our parser matches
 * ComfyUI's native "Save (API)" output — the user can diff this against
 * whatever ComfyUI's own editor produces for the same workflow.
 *
 * Output is stripped of per-submission randomness (seeds zeroed) so two
 * successive calls produce a stable payload for comparison.
 */
router.get('/template-api-prompt/:templateName', async (req: Request, res: Response) => {
  try {
    const templateName = req.params.templateName as string;
    const workflow = await loadWorkflowJson(templateName);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const apiPrompt = await workflowToApiPrompt(workflow, {}, []);
    for (const entry of Object.values(apiPrompt)) {
      if (entry.class_type === 'KSampler' && 'seed' in entry.inputs) entry.inputs.seed = 0;
      if (entry.class_type === 'RandomNoise' && 'noise_seed' in entry.inputs) entry.inputs.noise_seed = 0;
    }
    res.json({ templateName, apiPrompt });
  } catch (err) {
    sendError(res, err, 500, 'Failed to build API prompt');
  }
});

// Save the user's selection of which widgets should appear in Advanced Settings for this template.
router.put('/template-widgets/:templateName', (req: Request, res: Response) => {
  try {
    const templateName = req.params.templateName as string;
    const body = req.body as {
      exposed?: Array<{ nodeId: string; widgetName: string }>;
    };
    const saved = exposedWidgets.setForTemplate(templateName, body.exposed || []);
    res.json({ exposed: saved });
  } catch (err) {
    sendError(res, err, 400, 'Failed to save exposed widgets');
  }
});

export default router;
