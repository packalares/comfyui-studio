// Primitive walk: emit a form-field candidate for every titled Primitive*
// node anywhere in the workflow.
//
// CRITICAL: this collector iterates the FLATTENER's compound-id node space,
// NOT the raw `collectAllNodes` walk. That guarantees `bindNodeId` is the
// same compound id every other code path uses (`17:9` not `9`), so the
// dedup, claim set, and submit path all line up.
//
// `applyPrimitiveOverrides` (`prompt/inject.ts`) strips the wrapper-id
// prefix via `innerIdOf` before matching against the API prompt, so the
// compound bind survives the round-trip without any change to that file.

import type { FlatLink, FlatNode } from '../../workflow/flatten/index.js';
import type { FormFieldCandidate } from './types.js';
import type { FormInputData } from '../types.js';

const PRIMITIVE_TO_TYPE: Record<string, FormInputData['type']> = {
  PrimitiveStringMultiline: 'textarea',
  PrimitiveString: 'text',
  PrimitiveInt: 'number',
  PrimitiveFloat: 'number',
  PrimitiveBoolean: 'toggle',
};

/** Class types this module emits candidates for — exported for Rule C
 *  (widget-walk vs primitive collapse) in merge.ts. */
export const PRIMITIVE_CLASS_TYPES = new Set<string>(Object.keys(PRIMITIVE_TO_TYPE));

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

// Widget names that indicate a "prompt role" input on a text-encode node.
// Subset of inject.ts's PROMPT_WIDGET_NAMES — only those relevant to
// user-authored text (not audio tags/lyrics, which are handled separately).
const PROMPT_ROLE_INPUTS = new Set<string>([
  'text', 'prompt', 'clip_l', 't5xxl', 'text_g', 'text_l', 'positive_prompt',
]);

// Node types that pass their input through without transformation, so we
// follow them when tracing forward from a Primitive output.
const PASS_THROUGH_TYPES = new Set<string>([
  'Reroute', 'ComfySwitchNode', 'easy switch',
]);

/**
 * Return true when the output of `nodeId` ultimately reaches a text-encode
 * node's prompt-role input — directly or through pass-through nodes. Used
 * to override a Primitive's raw title with "Prompt" when the chain genuinely
 * terminates at a text-encoder's text/prompt input.
 *
 * Only follows simple forward links (no full resolveInput recursion) — this
 * is intentionally conservative: if the chain can't be traced in a small
 * number of hops, we don't override the label.
 */
function feedsPromptInput(
  nodeId: string,
  forwardLinks: Map<string, FlatLink[]>,
  flatNodes: Map<string, FlatNode>,
  visited: Set<string> = new Set(),
): boolean {
  if (visited.has(nodeId)) return false;
  visited.add(nodeId);
  const outLinks = forwardLinks.get(nodeId) ?? [];
  for (const link of outLinks) {
    const target = flatNodes.get(link.target_id);
    if (!target) continue;
    if (PASS_THROUGH_TYPES.has(target.type)) {
      if (feedsPromptInput(link.target_id, forwardLinks, flatNodes, visited)) return true;
      continue;
    }
    // Find what input name the link enters on the target node.
    const targetInput = target.inputs.find(inp => inp.link === link.id);
    if (!targetInput) continue;
    const inputName = targetInput.widget?.name ?? targetInput.name;
    if (PROMPT_ROLE_INPUTS.has(inputName)) return true;
  }
  return false;
}

/** Build a forward-link index: origin node id → outbound FlatLinks. */
function buildForwardLinks(links: FlatLink[]): Map<string, FlatLink[]> {
  const out = new Map<string, FlatLink[]>();
  for (const l of links) {
    if (!out.has(l.origin_id)) out.set(l.origin_id, []);
    out.get(l.origin_id)!.push(l);
  }
  return out;
}

function coerceDefault(
  raw: unknown,
  fieldType: FormInputData['type'],
): string | number | boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (fieldType === 'toggle') return Boolean(raw);
  if (fieldType === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return String(raw);
}

/**
 * Build a candidate for one Primitive node. Returns null when the node is
 * untitled or carries an unsupported class_type (bare `PrimitiveNode` from
 * legacy templates is intentionally excluded — it's inlined as a literal
 * via `resolveInput`, not driven by user form input).
 *
 * `compoundId` is the flattener's id for this Primitive — already prefixed
 * with the wrapper chain when buried in subgraphs (e.g. `267:240`).
 *
 * When the Primitive's output chain terminates at a text-encode prompt input,
 * the label is overridden to "Prompt" regardless of the node's raw title
 * (which tends to be verbose like "String (Multiline - Prompt)").
 */
function primitiveCandidate(
  compoundId: string,
  node: FlatNode,
  forwardLinks: Map<string, FlatLink[]>,
  flatNodes: Map<string, FlatNode>,
): FormFieldCandidate | null {
  const fieldType = PRIMITIVE_TO_TYPE[node.type];
  if (!fieldType) return null;
  if (!isNonEmptyString(node.title)) return null;

  const titleTrimmed = node.title.trim();
  const isPromptRole = /^prompt$/i.test(titleTrimmed);

  // Override label to "Prompt" when the output chain reaches a text-encode
  // prompt input — catches cases where the title is verbose or non-canonical.
  const feedsPrompt =
    isPromptRole
    || (fieldType === 'textarea' && feedsPromptInput(compoundId, forwardLinks, flatNodes));

  const default_ = coerceDefault(node.widgets_values?.[0], fieldType);

  const out: FormFieldCandidate = {
    id: feedsPrompt ? 'prompt' : `primitive:${compoundId}`,
    label: feedsPrompt ? 'Prompt' : titleTrimmed,
    type: fieldType,
    required: feedsPrompt,
    bindNodeId: compoundId,
    bindWidgetName: 'value',
    source: 'primitive',
  };
  if (default_ !== undefined) out.default = default_;
  return out;
}

/**
 * Walk the flattened node map, return one candidate per titled Primitive.
 * Document order is preserved by the flattener's insertion order.
 */
export function collectPrimitiveCandidates(
  flatNodes: Map<string, FlatNode>,
  flatLinks: FlatLink[],
): FormFieldCandidate[] {
  const forwardLinks = buildForwardLinks(flatLinks);
  const out: FormFieldCandidate[] = [];
  for (const [compoundId, node] of flatNodes) {
    const c = primitiveCandidate(compoundId, node, forwardLinks, flatNodes);
    if (c) out.push(c);
  }
  return out;
}
