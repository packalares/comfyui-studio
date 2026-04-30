// Widget walk: emit a candidate for every multiline-STRING widget on every
// non-negative-titled, non-wired node in the flattened workflow.
//
// Differences from the legacy walker (`promptSurfaceFieldsFromNodes`):
//   - No early return at first matching node. Every encoder gets its own
//     candidate so multi-encoder workflows (positive + negative split, or
//     primary + refiner) surface every editable prompt.
//   - Every emitted `bindNodeId` is the flattener's compound id, so dedup
//     and submit-path work uniformly across subgraph and flat workflows.
//   - Wired widgets are skipped (their value comes from upstream — the
//     upstream node owns the user-facing surface).

import type { FlatNode } from '../../workflow/flatten/index.js';
import {
  filteredWidgetValues, widgetNamesFor,
} from '../../workflow/rawWidgets/shapes.js';
import type { FormFieldCandidate } from './types.js';
import type { FormInputData } from '../types.js';

// Human labels for well-known prompt-surface widget names. Anything not in
// this map falls back to title-case of the widget name.
const WIDGET_LABELS: Record<string, string> = {
  text: 'Prompt',
  prompt: 'Prompt',
  positive_prompt: 'Positive Prompt',
  negative_prompt: 'Negative Prompt',
  tags: 'Style Tags',
  lyrics: 'Lyrics',
  clip_l: 'CLIP-L',
  t5xxl: 'T5-XXL',
  text_g: 'Text (G)',
  text_l: 'Text (L)',
};

function titleCaseWidget(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function isMultilineStringSpec(spec: unknown): boolean {
  if (!Array.isArray(spec) || spec[0] !== 'STRING') return false;
  return (spec[1] as { multiline?: boolean } | undefined)?.multiline === true;
}

/** True when `widgetName` on this node is wired upstream — i.e. an entry in
 *  `node.inputs` matches it (by `name` or `widget.name`) AND has a non-null
 *  `link`. Wired widgets are not user-editable; their upstream owns the
 *  surface (typically a Primitive or text-generator). */
function isWidgetWired(node: FlatNode, widgetName: string): boolean {
  for (const slot of node.inputs ?? []) {
    if (!slot) continue;
    const matches = slot.name === widgetName || slot.widget?.name === widgetName;
    if (!matches) continue;
    if (slot.link != null) return true;
  }
  return false;
}

/**
 * Walk every flattened node, emit one candidate per multiline-STRING widget
 * the user can author. Skips:
 *   - nodes with negative-titled labels (positive/negative encoder split)
 *   - nodes whose output flows into a sampler's `negative` input (title-
 *     less negative encoders that the title regex misses)
 *   - widgets that are wired upstream (the wire owns the surface)
 *   - nodes whose class type isn't in objectInfo
 */
export function collectWidgetWalkCandidates(
  flatNodes: Map<string, FlatNode>,
  objectInfo: Record<string, Record<string, unknown>>,
  negativeNodeIds: Set<string>,
): FormFieldCandidate[] {
  const out: FormFieldCandidate[] = [];
  for (const [compoundId, node] of flatNodes) {
    if (!node.type) continue;
    if (/negative/i.test(node.title || '')) continue;
    if (negativeNodeIds.has(compoundId)) continue;
    const schema = objectInfo[node.type] as {
      input?: {
        required?: Record<string, unknown>;
        optional?: Record<string, unknown>;
      };
    } | undefined;
    if (!schema?.input) continue;
    const declared = { ...(schema.input.required || {}), ...(schema.input.optional || {}) };
    const targets: string[] = [];
    for (const [name, spec] of Object.entries(declared)) {
      if (!isMultilineStringSpec(spec)) continue;
      if (isWidgetWired(node, name)) continue;
      targets.push(name);
    }
    if (targets.length === 0) continue;

    const widgetNames = widgetNamesFor(objectInfo, node.type);
    const wv = filteredWidgetValues(node.widgets_values);
    for (const widgetName of targets) {
      const pos = widgetNames.indexOf(widgetName);
      const defaultRaw = pos >= 0 ? wv[pos] : undefined;
      const c: FormFieldCandidate = {
        id: widgetName,
        label: WIDGET_LABELS[widgetName] ?? titleCaseWidget(widgetName),
        type: 'textarea' satisfies FormInputData['type'],
        required: true,
        bindNodeId: compoundId,
        bindWidgetName: widgetName,
        source: 'widget-walk',
      };
      if (typeof defaultRaw === 'string') c.default = defaultRaw;
      out.push(c);
    }
  }
  return out;
}
