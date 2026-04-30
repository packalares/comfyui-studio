// Promote wrapper-proxy prompt widgets to bound main-form fields.
//
// Many comfy-org templates (Z-Image-Turbo Fun Union ControlNet, Flux.2 Dev
// t2i, …) wrap a CLIPTextEncode inside a subgraph wrapper whose
// `proxyWidgets` list exposes the encoder's `text` widget. Those workflows
// have:
//   - no Primitive titled "Prompt" (so the primitive walker emits nothing
//     prompt-shaped),
//   - the inner encoder's `text` input is wired upstream from the subgraph
//     input port (so the widget walker correctly skips it).
// Without this collector the user would see the prompt only inside Advanced
// Settings (under the proxy label "Text"), with the legacy unbound generic
// prompt textbox still in the main form.
//
// Promotion writes a BOUND main-form field with a compound bind id
// (`<wrapperId>:<innerId>`) so the matching proxy entry auto-drops from
// Advanced Settings via the form-claim filter.

import type { FlatNode } from '../../workflow/flatten/index.js';
import { findSubgraphDef, resolveProxyBoundKeys } from '../../workflow/proxyLabels.js';
import {
  filteredWidgetValues, widgetNamesFor,
} from '../../workflow/rawWidgets/shapes.js';
import type { FormFieldCandidate } from './types.js';

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

const KNOWN_PROMPT_WIDGET_NAMES = new Set<string>(['text', 'prompt']);

/**
 * Walk every wrapper node's `proxyWidgets`, emit a `proxy-promote` candidate
 * for each entry whose inner widget is multiline STRING (or is named after
 * a known prompt-surface widget when objectInfo isn't available for the
 * inner class).
 *
 * `flatNodes` is used only to verify the resolved compound id resolves to a
 * real flat node — gates against author errors that point a proxy at a
 * non-existent inner id.
 */
export function collectProxyPromoteCandidates(
  workflow: Record<string, unknown>,
  flatNodes: Map<string, FlatNode>,
  objectInfo: Record<string, Record<string, unknown>>,
  negativeNodeIds: Set<string>,
): FormFieldCandidate[] {
  const out: FormFieldCandidate[] = [];
  const wrappers = (workflow.nodes as Array<Record<string, unknown>> | undefined) || [];
  for (const wrapper of wrappers) {
    const props = wrapper.properties as Record<string, unknown> | undefined;
    const proxyList = props?.proxyWidgets as unknown;
    if (!Array.isArray(proxyList)) continue;
    const sgDef = findSubgraphDef(wrapper, workflow);
    if (!sgDef) continue;
    const innerNodes = (sgDef.nodes as Array<Record<string, unknown>> | undefined) || [];
    const resolved = resolveProxyBoundKeys(
      wrapper, proxyList as string[][], workflow,
    );
    for (const { nodeId, widgetName } of resolved) {
      // Sanity: skip when the resolved compound id isn't in the flat node
      // map. Either the workflow is malformed or the proxy points at a
      // node-shaped artifact (subgraph self-input that doesn't bind to a
      // concrete inner node).
      if (!flatNodes.has(nodeId)) continue;
      // Skip negative-conditioning encoders — same rule the widget walker
      // applies. Title-less negative encoders only get caught by the
      // wire-based detection.
      if (negativeNodeIds.has(nodeId)) continue;
      const colon = nodeId.lastIndexOf(':');
      const innerId = colon >= 0 ? nodeId.slice(colon + 1) : nodeId;
      const inner = innerNodes.find(n => String(n.id) === innerId);
      if (!inner) continue;
      const classType = (inner.type as string | undefined)
        || (inner.class_type as string | undefined);
      if (!classType) continue;
      if (/negative/i.test((inner.title as string | undefined) || '')) continue;

      const schema = objectInfo[classType] as {
        input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
      } | undefined;
      const declared = schema?.input
        ? { ...(schema.input.required || {}), ...(schema.input.optional || {}) }
        : null;
      const schemaSaysMultiline = declared
        ? isMultilineStringSpec(declared[widgetName])
        : false;
      if (!schemaSaysMultiline && !KNOWN_PROMPT_WIDGET_NAMES.has(widgetName)) continue;

      const widgetNames = widgetNamesFor(objectInfo, classType);
      const wv = filteredWidgetValues(inner.widgets_values as unknown[] | undefined);
      const pos = widgetNames.indexOf(widgetName);
      const defaultRaw = pos >= 0 ? wv[pos] : undefined;
      const c: FormFieldCandidate = {
        id: widgetName,
        label: WIDGET_LABELS[widgetName] ?? titleCaseWidget(widgetName),
        type: 'textarea',
        required: true,
        bindNodeId: nodeId,
        bindWidgetName: widgetName,
        source: 'proxy-promote',
      };
      if (typeof defaultRaw === 'string') c.default = defaultRaw;
      out.push(c);
    }
  }
  return out;
}
