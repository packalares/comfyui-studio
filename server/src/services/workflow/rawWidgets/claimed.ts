// Compute the set of widgets already claimed by the main form — the
// "Expose fields" modal must not offer these (they would be silently
// clobbered by the generate pipeline). Two paths:
//
//  1. Primary: read `template.formInputs` and claim exactly the
//     (bindNodeId, bindWidgetName) pairs — one form field, one claim.
//     Deterministic and aligned with the bound injector in
//     `workflow/prompt/inject.ts::applyBoundFormInputs`.
//
//  2. Fallback: for tag-only templates whose formInputs carry no
//     bindings (upstream catalog entries that never saw their workflow
//     at generation time), mirror the legacy heuristic: the first
//     non-negative-titled node's multiline-STRING widgets. This path
//     exists solely to keep the generic-prompt fan-out case hiding the
//     same widgets it used to hide — once every template flows through
//     the bound path, this block becomes dead code and can be removed.

import * as templates from '../../templates/index.js';
import { widgetNamesFor } from './shapes.js';

// Fallback path: mirror the legacy node-walk used by the non-bound
// `injectUserPrompt` fan-out. Only runs when no bound formInputs exist.
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
    return claimed; // mirror legacy injectUserPrompt: only first eligible node
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
 * Primary path: walk `template.formInputs` and claim exactly the
 * widgets pointed to by `(bindNodeId, bindWidgetName)`. Returns the
 * claim set plus a flag so the caller knows whether the bound path
 * produced anything — the legacy path only kicks in if it didn't.
 */
function collectBoundPromptClaimedWidgets(
  templateName: string,
): { claimed: Set<string>; hadAny: boolean } {
  const tpl = templates.getTemplate(templateName);
  const claimed = new Set<string>();
  let hadAny = false;
  for (const fi of (tpl?.formInputs || [])) {
    const bindNodeId = (fi as { bindNodeId?: string }).bindNodeId;
    const bindWidgetName = (fi as { bindWidgetName?: string }).bindWidgetName;
    if (!bindNodeId || !bindWidgetName) continue;
    hadAny = true;
    claimed.add(`${bindNodeId}|${bindWidgetName}`);
  }
  return { claimed, hadAny };
}

/**
 * Union of prompt-claimed + formInput-claimed widget IDs
 * (`${nodeId}|${widgetName}`). The modal uses this to hide widgets that
 * would be silently overwritten at generate time.
 *
 * INVARIANT: every claim key uses a TOP-LEVEL numeric node id. Inner
 * subgraph widgets are enumerated with compound ids (`267:216` /
 * `267:mid:leaf`) by `walkSubgraphWidgets`, so nothing here will ever
 * match them — they stay strictly opt-in. Keep it this way: claim
 * semantics are a top-level concept (prompt textarea / upload bindings
 * wire to top-level nodes), and re-introducing compound-id matching
 * would accidentally hide widgets users specifically asked to expose.
 */
export function computeFormClaimedWidgets(
  workflow: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
  templateName: string,
): Set<string> {
  const nodes = (workflow.nodes || []) as Array<Record<string, unknown>>;
  const claimed = new Set<string>();
  const bound = collectBoundPromptClaimedWidgets(templateName);
  for (const k of bound.claimed) claimed.add(k);
  // Legacy fallback only when no bound prompt fields exist — keeps the
  // generic-prompt fan-out case hiding the same widgets it used to hide.
  if (!bound.hadAny) {
    for (const k of collectLegacyPromptClaimedWidgets(nodes, objectInfo)) claimed.add(k);
  }
  for (const k of collectFormInputClaimedWidgets(nodes, objectInfo, templateName)) claimed.add(k);
  return claimed;
}
