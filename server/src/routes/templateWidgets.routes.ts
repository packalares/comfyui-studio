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
  findSubgraphDef,
  getObjectInfo,
  resolveProxyLabelParts,
  workflowToApiPrompt,
} from '../services/workflow/index.js';
import { generateFormInputs } from '../services/templates/templates.formInputs.js';
import { filterProxySettingsAgainstForm } from '../services/workflow/filterFormBoundProxies.js';
import type { RawTemplate } from '../services/templates/types.js';
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
      const parts = resolveProxyLabelParts(wrapperNode, proxyWidgets, workflow);
      const labels = parts.map(p => p.label);
      const scopeLabels = parts.map(p => p.scopeLabel);
      const sg = findSubgraphDef(wrapperNode, workflow);
      const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
      const sgInputs = (sg?.inputs || []) as Array<Record<string, unknown>>;
      const sgLinks = (sg?.links || []) as Array<Record<string, unknown>>;
      settings = extractAdvancedSettings(
        proxyWidgets, widgetValues, objectInfo, labels, sgNodes, scopeLabels,
        sgInputs, sgLinks,
      );
      // Dedup: a proxy entry whose (innerNodeId, widgetName) matches a bound
      // main-form field is redundant — the main form is the authoritative
      // surface for bound widgets (Phase 1). Showing the same widget in
      // Advanced Settings creates two edit surfaces for one value. Mirrors
      // the generateFormInputs call shape used by /template-widgets so the
      // binding keys stay in lock-step.
      settings = filterProxySettingsAgainstForm(
        settings,
        proxyWidgets,
        templateName,
        workflow,
        objectInfo,
        wrapperNode,
      );
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
// Also returns `primitiveFormFields` — the full `generateFormInputs` output computed against the
// live workflow + objectInfo. Superset of the legacy primitive-only list: subgraph-titled
// Primitive* nodes still surface, plus widget-walk fields with `bindNodeId`+`bindWidgetName` for
// modern multi-field encoders (TextEncodeAceStepAudio1.5's `tags`/`lyrics` etc.) so the Studio
// form can route each field to its own widget instead of fanning one prompt across all of them.
router.get('/template-widgets/:templateName', async (req: Request, res: Response) => {
  try {
    const templateName = req.params.templateName as string;
    const workflow = await loadWorkflowJson(templateName);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    const widgets = await enumerateTemplateWidgets(workflow, templateName);
    const objectInfo = await getObjectInfo();
    // Synthesise a RawTemplate shell from the cached TemplateData so tags /
    // description flow into the fallback (tag-only) prompt path. Missing
    // entries (templateless lookups) degrade gracefully to empty tags.
    const tpl = templates.getTemplate(templateName);
    const raw: RawTemplate = {
      name: templateName,
      title: tpl?.title ?? templateName,
      description: tpl?.description ?? '',
      mediaType: tpl?.mediaType ?? 'image',
      tags: tpl?.tags ?? [],
      models: tpl?.models ?? [],
      io: tpl?.io,
    };
    const primitiveFormFields = generateFormInputs(raw, workflow, objectInfo);
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
