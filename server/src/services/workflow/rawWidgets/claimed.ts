// Compute the set of widgets already claimed by the main form — the
// "Expose fields" modal must not offer these (they would be silently
// clobbered by the generate pipeline). Must mirror the node-picking logic
// in `workflowToApiPrompt` exactly.

import * as templates from '../../templates/index.js';
import { widgetNamesFor } from './shapes.js';

// Prompt-claimed widgets: the first non-negative-titled node with
// multiline STRING widgets. Every such widget on it is claimed.
function collectPromptClaimedWidgets(
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
    return claimed; // mirror workflowToApiPrompt: only first eligible node
  }
  return claimed;
}

// Widgets on nodes bound via template.formInputs[*].nodeId —
// image/audio/video uploaders and their sibling widgets.
function collectFormInputClaimedWidgets(
  nodes: Array<Record<string, unknown>>,
  objectInfo: Record<string, Record<string, unknown>>,
  templateName: string,
): Set<string> {
  const claimed = new Set<string>();
  const tpl = templates.getTemplate(templateName);
  for (const fi of (tpl?.formInputs || [])) {
    // IO boundary: formInputs comes from user-authored template JSON, and the
    // nodeId field is declared `number` in the contract but some workflows
    // surface it as a string. Accept both.
    const nodeId = (fi as unknown as { nodeId?: number | string }).nodeId;
    if (nodeId == null) continue;
    const node = nodes.find(n => String(n.id) === String(nodeId));
    if (!node) continue;
    const classType = (node.type as string | undefined) || (node.class_type as string | undefined);
    if (!classType) continue;
    for (const name of widgetNamesFor(objectInfo, classType)) {
      claimed.add(`${nodeId}|${name}`);
    }
  }
  return claimed;
}

/**
 * Union of the prompt-claimed + formInput-claimed widget IDs
 * (`${nodeId}|${widgetName}`). Used by the modal to hide widgets that
 * would be silently overwritten at generate time.
 */
export function computeFormClaimedWidgets(
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
  templateName: string,
): Set<string> {
  const nodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  const claimed = new Set<string>();
  for (const k of collectPromptClaimedWidgets(nodes, objectInfo)) claimed.add(k);
  for (const k of collectFormInputClaimedWidgets(nodes, objectInfo, templateName)) claimed.add(k);
  return claimed;
}
