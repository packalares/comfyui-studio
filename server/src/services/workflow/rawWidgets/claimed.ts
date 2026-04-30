// Compute the set of widgets already claimed by the main form. Single source
// of truth: the `claimSet` returned by `buildFormFieldPlan(workflow,
// objectInfo, template)` — every bound form field auto-claims its widget so
// the "Expose fields" modal can hide it.
//
// The plan's claimSet covers:
//   - primitive walk (every titled Primitive's `value` widget),
//   - widget walk (every multiline-STRING widget on every encoder),
//   - proxy promotion (wrapper-proxy prompts surfaced to the main form),
//   - any future collector that emits bound fields.
//
// File-upload widgets on media-loader nodes are added on top because they
// don't go through the bind path (they use `nodeId` + a per-mediaType
// allowlist of widget names), and the legacy fan-out fallback for tag-only
// templates is still added when the bound path produced nothing.

import { buildFormFieldPlan } from '../../templates/formFieldPlan/index.js';
import * as templates from '../../templates/index.js';
import type { RawTemplate } from '../../templates/types.js';

const UPLOAD_WIDGETS_BY_MEDIA_TYPE: Record<string, readonly string[]> = {
  image: ['image', 'upload'],
  audio: ['audio', 'audio_file'],
  video: ['video'],
};

// Fallback: when no bound prompt fields exist (tag-only templates whose
// formInputs don't carry bindings), mirror the legacy first-eligible-node
// fan-out so the modal still hides what the prompt-injection path will
// later overwrite.
function collectLegacyPromptClaimedWidgets(
  nodes: Array<Record<string, unknown>>,
  objectInfo: Record<string, Record<string, unknown>>,
): Set<string> {
  const claimed = new Set<string>();
  for (const node of nodes) {
    const classType = (node.type as string | undefined) || (node.class_type as string | undefined);
    if (!classType) continue;
    const title = (node.title as string | undefined) || '';
    if (/negative/i.test(title)) continue;
    const schema = objectInfo[classType] as {
      input?: {
        required?: Record<string, unknown>;
        optional?: Record<string, unknown>;
      };
    } | undefined;
    const inputs = { ...(schema?.input?.required || {}), ...(schema?.input?.optional || {}) };
    const targets: string[] = [];
    for (const [name, spec] of Object.entries(inputs)) {
      if (!Array.isArray(spec) || spec[0] !== 'STRING') continue;
      if ((spec[1] as { multiline?: boolean } | undefined)?.multiline === true) targets.push(name);
    }
    if (targets.length === 0) continue;
    const nodeId = String(node.id);
    for (const name of targets) claimed.add(`${nodeId}|${name}`);
    return claimed;
  }
  return claimed;
}

// Media-upload widgets: claim the per-mediaType allowlist on every loader
// node referenced by `template.io.inputs`. Scoped to the upload-relevant
// widget names so loader-config widgets (custom_width, frame_load_cap, ...)
// stay user-exposable.
function collectFormInputClaimedWidgets(
  nodes: Array<Record<string, unknown>>,
  templateName: string,
): Set<string> {
  const claimed = new Set<string>();
  const tpl = templates.getTemplate(templateName);
  for (const fi of (tpl?.formInputs || [])) {
    const nodeId = (fi as unknown as { nodeId?: number | string }).nodeId;
    if (nodeId == null) continue;
    const node = nodes.find(n => String(n.id) === String(nodeId));
    if (!node) continue;
    const mediaType = (fi as { mediaType?: string }).mediaType;
    if (!mediaType) continue;
    const widgetsToClaim = UPLOAD_WIDGETS_BY_MEDIA_TYPE[mediaType];
    if (!widgetsToClaim) continue;
    for (const name of widgetsToClaim) claimed.add(`${nodeId}|${name}`);
  }
  return claimed;
}

function rawTemplate(templateName: string): RawTemplate {
  const tpl = templates.getTemplate(templateName);
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

/**
 * Union of: (a) main-form bound widgets via the canonical plan, (b) media-
 * upload allowlists per mediaType, and (c) the legacy first-eligible-node
 * fallback when the plan produced no bound prompt fields.
 *
 * Keys are `${nodeId}|${widgetName}` where `nodeId` follows the same compound
 * convention the flattener emits (e.g. `17:9` for subgraph-buried inputs).
 * The legacy path uses bare top-level numeric ids — they coexist in the same
 * set because a workflow either flows through the bound path (compound ids)
 * OR through the legacy path (bare ids), never both at once.
 */
export function computeFormClaimedWidgets(
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
  templateName: string,
): Set<string> {
  const claimed = new Set<string>();
  const plan = buildFormFieldPlan(rawTemplate(templateName), workflow, objectInfo);
  for (const k of plan.claimSet) claimed.add(k);

  const nodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  if (plan.claimSet.size === 0) {
    for (const k of collectLegacyPromptClaimedWidgets(nodes, objectInfo)) claimed.add(k);
  }
  for (const k of collectFormInputClaimedWidgets(nodes, templateName)) claimed.add(k);
  return claimed;
}
