// Subgraph-aware extraction of user-editable form fields from a workflow.
//
// ComfyUI 0.3.51+ subgraph workflows encode their user-tunable parameters
// as typed Primitive* nodes inside `definitions.subgraphs[*].nodes`. Each
// carries a human-friendly `title` (Prompt / Width / Height / Length /
// Frame Rate / ...) and a default in `widgets_values[0]`. The wrapper node
// in the parent graph exposes these via `properties.proxyWidgets`.
//
// Studio's template listing uses a tag-based heuristic to pick default
// form fields (image upload + generic prompt textarea). That heuristic
// doesn't see subgraph Primitives, so for LTX2-style workflows the form
// shows only an Image upload — missing Prompt/Width/Height/etc.
//
// `extractPrimitiveFormFields` fixes that: walks top-level nodes +
// every subgraph's nodes, collects titled Primitive* nodes, returns
// FormInputData entries Studio can merge into the template form.

import type { FormInputData } from '../../services/templates/types.js';
import { collectAllNodes, type WorkflowWithSubgraphs } from './walkNodes.js';

type Node = Record<string, unknown>;

const PRIMITIVE_TO_TYPE: Record<string, FormInputData['type']> = {
  PrimitiveStringMultiline: 'textarea',
  PrimitiveString: 'text',
  PrimitiveInt: 'number',
  PrimitiveFloat: 'number',
  PrimitiveBoolean: 'toggle',
};

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

/**
 * Build a FormInputData entry for one Primitive* node. Returns null when
 * the node has no meaningful title or carries an unsupported class_type —
 * untitled primitives are serialization artifacts and should stay hidden.
 *
 * Primitives titled "Prompt" (case-insensitive) special-case to id `prompt`
 * so the main form's prompt textarea renders and pre-fills naturally. All
 * others get a stable id `primitive:<nodeId>` so Phase C override-routing
 * can map a user edit back to the correct Primitive node's widget value.
 */
function primitiveToFormInput(node: Node): FormInputData | null {
  const classType = node.type as string | undefined;
  if (!classType) return null;
  const fieldType = PRIMITIVE_TO_TYPE[classType];
  if (!fieldType) return null;
  const title = node.title as string | undefined;
  if (!isNonEmptyString(title)) return null;

  const nodeId = typeof node.id === 'number' || typeof node.id === 'string'
    ? String(node.id)
    : null;
  if (!nodeId) return null;

  const defaultValue = (node.widgets_values as unknown[] | undefined)?.[0];
  const isPromptRole = /^prompt$/i.test(title.trim());

  const field: FormInputData = {
    id: isPromptRole ? 'prompt' : `primitive:${nodeId}`,
    label: title,
    type: fieldType,
    required: isPromptRole,
    // Bind every Primitive field to its own `value` widget so the
    // generate pipeline's bound-injection path can write to it directly.
    // Keeps primitive + widget-walk fields on the same injection contract.
    bindNodeId: nodeId,
    bindWidgetName: 'value',
  };
  if (defaultValue !== undefined && defaultValue !== null) {
    if (fieldType === 'toggle') {
      field.default = Boolean(defaultValue);
    } else if (fieldType === 'number') {
      const n = Number(defaultValue);
      if (Number.isFinite(n)) field.default = n;
    } else {
      field.default = String(defaultValue);
    }
  }
  return field;
}

/**
 * Walk the workflow, collect every user-meaningful Primitive* node's
 * equivalent form field. Preserves document order so the UI renders them
 * roughly in the order the template author laid them out.
 *
 * Deduplication: if multiple Primitive nodes end up with the same field id
 * (e.g. two subgraphs each carry a "Prompt" primitive), the FIRST one
 * wins — the second is discarded. This is unusual in practice but could
 * happen with templates that bundle sibling subgraphs.
 */
export function extractPrimitiveFormFields(
  workflow: Record<string, unknown>,
): FormInputData[] {
  const result: FormInputData[] = [];
  const seen = new Set<string>();
  for (const node of collectAllNodes(workflow as WorkflowWithSubgraphs<Node>)) {
    const field = primitiveToFormInput(node);
    if (!field) continue;
    if (seen.has(field.id)) continue;
    seen.add(field.id);
    result.push(field);
  }
  return result;
}
