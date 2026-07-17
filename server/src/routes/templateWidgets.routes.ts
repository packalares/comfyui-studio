// Template widget routes: enumerate raw-node widgets the user can expose,
// persist their selection, and return the merged Advanced Settings list
// (proxy-widget entries + user-exposed raw-node entries).

import fs from 'fs';
import { Router, type Request, type Response, type NextFunction } from 'express';
import * as exposedWidgets from '../services/exposedWidgets.js';
import * as templates from '../services/templates/index.js';
import * as templatePresetsRepo from '../lib/db/templatePresets.repo.js';
import { paths } from '../config/paths.js';
import { safeResolve } from '../lib/fs.js';
import {
  buildRawWidgetSettings,
  enumerateTemplateWidgets,
  extractAdvancedSettings,
  findSubgraphDef,
  getObjectInfo,
  resolveProxyLabelParts,
  resolveProxyBoundKeys,
} from '../services/workflow/index.js';
import { buildStableApiPrompt } from '../services/workflow/stableApiPrompt.js';
import { computeWorkflowGroups } from '../services/workflow/workflowGroups.js';
import { buildFormFieldPlan, disambiguateFieldLabels } from '../services/templates/formFieldPlan/index.js';
import { filterProxySettingsByBoundKeys } from '../services/workflow/filterFormBoundProxies.js';
import type { RawTemplate } from '../services/templates/types.js';
import { NotFoundError, InternalError } from '../lib/errors.js';
import type { AdvancedSetting } from '../contracts/workflow.contract.js';

/**
 * Load a workflow JSON by template name. All templates now live on disk in
 * user-workflows/ — read from disk directly.
 * ComfyUI's `/templates/:name.json` for upstream templates.
 */
// All templates now live on disk in user-workflows/ — read from disk directly.
async function loadWorkflowJson(templateName: string): Promise<Record<string, unknown> | null> {
  return templates.getUserWorkflowJson(templateName);
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

function rawTemplateOf(templateName: string): RawTemplate {
  // Read from disk JSON for full metadata (title, io, etc.).
  const tpl = templates.getUserTemplate(templateName);
  return {
    name: templateName,
    title: tpl?.title ?? templateName,
    description: tpl?.description ?? '',
    mediaType: tpl?.mediaType ?? 'image',
    tags: tpl?.tags ?? [],
    models: tpl?.models ?? [],
    io: tpl?.io,
  };
}

/** Compute every payload the Studio page needs from one workflow load.
 *  Returns null when the workflow is missing so the route can surface a 404.
 *  All three derivations (settings, widgets, primitiveFormFields) share the
 *  same workflow JSON, the same memoised `getObjectInfo`, and the same
 *  `buildFormFieldPlan` invocation — they used to re-run them per endpoint.
 *
 *  Easy-mode templates (`studioBuilder` set to image/video/audio) short-
 *  circuit before the heavy workflow parse: Image/VideoBuilder.tsx only ever
 *  read `res.builderMeta`, so loading the workflow JSON, hitting comfy for
 *  `getObjectInfo`, building the form-field plan, extracting advanced
 *  settings, enumerating widgets, and computing apiPrompt+groups is wasted
 *  work that ends up discarded by the caller. */
export async function buildTemplateBundle(templateName: string) {
  // Cheap: one small sidecar file read. Tells us whether this template will
  // be consumed by an Easy-mode builder (Image/Video/Audio) or by the Studio
  // page (classic — needs the full bundle).
  const tpl = templates.getUserTemplate(templateName);
  const builderMeta = tpl
    ? {
        studioBuilder: tpl.studioBuilder,
        title: tpl.title,
        studioModes: tpl.studioModes,
        promptEnhancer: tpl.promptEnhancer,
        // Per-mode UI toggles. UI merges the `:` shared entry with the
        // active mode's entry to decide which buttons to render in the
        // prompt card. Server-side resolution lives in generate.routes.ts.
        prompt_toggles: tpl.prompt_toggles,
      }
    : undefined;

  // Preset display cards are stored on the templates.template_presets JSON
  // column by the import hook. Read once and forward as-is — the column
  // already carries local-rewritten previewUrls so no per-card URL massaging.
  const presets = templatePresetsRepo.getPresets(templateName);

  // Easy-mode short-circuit: Image/VideoBuilder.tsx only read `builderMeta`,
  // so we can skip the workflow load + plan/widget/apiPrompt/groups build
  // entirely. Shape stays identical for the consumer — fields they ignore
  // are present but empty. `presets` rides along so the right-panel grid can
  // render without a second round trip.
  if (tpl?.studioBuilder) {
    return {
      settings: [] as AdvancedSetting[],
      widgets: [],
      primitiveFormFields: [],
      apiPrompt: {},
      groups: [],
      builderMeta,
      presets,
    };
  }

  const workflow = await loadWorkflowJson(templateName);
  if (!workflow) return null;
  const objectInfo = await getObjectInfo();
  const plan = buildFormFieldPlan(rawTemplateOf(templateName), workflow, objectInfo);

  let settings: AdvancedSetting[] = [];
  const { wrapperNode, proxyWidgets, widgetValues } = findWrapperNode(workflow);
  if (wrapperNode && proxyWidgets && proxyWidgets.length > 0) {
    const parts = resolveProxyLabelParts(wrapperNode, proxyWidgets, workflow);
    const labels = parts.map((p) => p.label);
    const scopeLabels = parts.map((p) => p.scopeLabel);
    const sg = findSubgraphDef(wrapperNode, workflow);
    const sgNodes = (sg?.nodes || []) as Array<Record<string, unknown>>;
    const sgInputs = (sg?.inputs || []) as Array<Record<string, unknown>>;
    const sgLinks = (sg?.links || []) as Array<Record<string, unknown>>;
    const wrapperNodeId = String(wrapperNode.id ?? '') || undefined;
    const wrapperNodeTitle =
      ((wrapperNode.title as string | undefined) || (sg?.name as string | undefined)
        || (wrapperNode.type as string | undefined)) ?? undefined;
    settings = extractAdvancedSettings(
      proxyWidgets, widgetValues, objectInfo, labels, sgNodes, scopeLabels,
      sgInputs, sgLinks, wrapperNodeId, wrapperNodeTitle,
    );
    const resolvedKeys = resolveProxyBoundKeys(wrapperNode, proxyWidgets, workflow);
    settings = filterProxySettingsByBoundKeys(
      settings, proxyWidgets, plan.claimSet, resolvedKeys,
    );
  }
  const userExposed = exposedWidgets.getForTemplate(templateName);
  if (userExposed.length > 0) {
    const rawSettings = buildRawWidgetSettings(workflow, userExposed, objectInfo, templateName);
    settings.push(...rawSettings);
  }

  const widgets = await enumerateTemplateWidgets(workflow, templateName);
  const apiPrompt = await buildStableApiPrompt(workflow);
  const groups = computeWorkflowGroups(workflow, apiPrompt);
  const primitiveFormFields = disambiguateFieldLabels(plan.fields, groups);
  // builderMeta was resolved at the top so the Easy-mode short-circuit
  // could use it; classic-path templates carry it too in case the Studio
  // page ever surfaces builder-mode flags on a classic template. `presets`
  // is forwarded for the same reason — classic templates almost never have
  // presets today, but the field is always present so the client doesn't
  // branch on its existence.
  return { settings, widgets, primitiveFormFields, apiPrompt, groups, builderMeta, presets };
}

router.get('/workflow-settings/:templateName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bundle = await buildTemplateBundle(req.params.templateName as string);
    if (!bundle) throw new NotFoundError('Workflow not found');
    res.json({ settings: bundle.settings });
  } catch (err) {
    next(err instanceof Error ? err : new InternalError('Failed to extract workflow settings'));
  }
});

// List every editable widget in a template's workflow, each tagged with whether it's currently exposed.
// Also returns `primitiveFormFields` — the canonical form-field plan computed against the
// live workflow + objectInfo. Superset of the legacy primitive-only list: subgraph-titled
// Primitive* nodes still surface, plus widget-walk fields with `bindNodeId`+`bindWidgetName` for
// modern multi-field encoders (TextEncodeAceStepAudio1.5's `tags`/`lyrics` etc.) so the Studio
// form can route each field to its own widget instead of fanning one prompt across all of them.
router.get('/template-widgets/:templateName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bundle = await buildTemplateBundle(req.params.templateName as string);
    if (!bundle) throw new NotFoundError('Workflow not found');
    res.json({ widgets: bundle.widgets, primitiveFormFields: bundle.primitiveFormFields });
  } catch (err) {
    next(err instanceof Error ? err : new InternalError('Failed to enumerate template widgets'));
  }
});

// Single round-trip equivalent of `/workflow-settings` + `/template-widgets`.
// Studio page open used to fire both back-to-back; serving them together
// halves network trips and runs `loadWorkflowJson` + `buildFormFieldPlan`
// once instead of twice.
router.get('/template-bundle/:templateName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bundle = await buildTemplateBundle(req.params.templateName as string);
    if (!bundle) throw new NotFoundError('Workflow not found');
    res.json(bundle);
  } catch (err) {
    next(err instanceof Error ? err : new InternalError('Failed to build template bundle'));
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
router.get('/template-api-prompt/:templateName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const templateName = req.params.templateName as string;
    const workflow = await loadWorkflowJson(templateName);
    if (!workflow) throw new NotFoundError('Workflow not found');
    const apiPrompt = await buildStableApiPrompt(workflow);
    res.json({ templateName, apiPrompt });
  } catch (err) {
    next(err instanceof Error ? err : new InternalError('Failed to build API prompt'));
  }
});

// Click-to-load endpoint for Easy-mode preset cards. Reads the per-preset
// settings JSON the import hook wrote into
// `<userTemplatesDir>/<parent>/<presetId>.json` and returns it verbatim so
// the UI can fill the Builder form. The matching display card from the
// `templates.template_presets` column rides along so the client doesn't
// need a second lookup to render "now applying: <title>" feedback.
router.get(
  '/template-presets/:parent/:presetId',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const parent = req.params.parent as string;
      const presetId = req.params.presetId as string;
      // safeResolve protects against traversal even though both segments
      // came through express's `:param` matchers — defence in depth.
      let abs: string;
      try {
        abs = safeResolve(paths.userTemplatesDir, parent, `${presetId}.json`);
      } catch {
        throw new NotFoundError('Preset path not allowed');
      }
      if (!fs.existsSync(abs)) {
        throw new NotFoundError('Preset settings file not found');
      }
      let settings: unknown;
      try {
        settings = JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch (parseErr) {
        throw new InternalError(`Preset JSON malformed: ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`);
      }
      // Card lookup is best-effort — missing card just means the column was
      // cleared (soft-deleted parent) while the on-disk file lingered. We
      // return the settings either way; the UI keeps working.
      const cards = templatePresetsRepo.getPresets(parent);
      const card = cards.find((c) => c.id === presetId) ?? null;
      res.json({ id: presetId, parent, settings, card });
    } catch (err) {
      next(err instanceof Error ? err : new InternalError('preset load failed'));
    }
  },
);

// Save the user's selection of which widgets should appear in Advanced Settings for this template.
router.put('/template-widgets/:templateName', (req: Request, res: Response, next: NextFunction) => {
  try {
    const templateName = req.params.templateName as string;
    const body = req.body as {
      exposed?: Array<{ nodeId: string; widgetName: string }>;
    };
    const saved = exposedWidgets.setForTemplate(templateName, body.exposed || []);
    res.json({ exposed: saved });
  } catch (err) {
    next(err instanceof Error ? err : new InternalError('Failed to save exposed widgets'));
  }
});

export default router;
