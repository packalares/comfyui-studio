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

import type { FlatNode } from '../../workflow/flatten/index.js';
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
 */
function primitiveCandidate(
  compoundId: string,
  node: FlatNode,
): FormFieldCandidate | null {
  const fieldType = PRIMITIVE_TO_TYPE[node.type];
  if (!fieldType) return null;
  if (!isNonEmptyString(node.title)) return null;

  const isPromptRole = /^prompt$/i.test(node.title.trim());
  const default_ = coerceDefault(node.widgets_values?.[0], fieldType);

  const out: FormFieldCandidate = {
    id: isPromptRole ? 'prompt' : `primitive:${compoundId}`,
    label: node.title,
    type: fieldType,
    required: isPromptRole,
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
): FormFieldCandidate[] {
  const out: FormFieldCandidate[] = [];
  for (const [compoundId, node] of flatNodes) {
    const c = primitiveCandidate(compoundId, node);
    if (c) out.push(c);
  }
  return out;
}
