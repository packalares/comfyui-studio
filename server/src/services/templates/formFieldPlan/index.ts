// Single canonical entry point for form-field generation.
//
// `buildFormFieldPlan` returns `{fields, claimSet}` in one pass. Every
// consumer (`/template-widgets`, `/workflow-settings`, the dedup filter,
// the form-claimed widget set) reads from this struct so all of them
// reason about the SAME bound widgets — no more drift between
// `generateFormInputs` and `computeFormClaimedWidgets`.

import { flattenWorkflow, type FlatLink, type FlatNode } from '../../workflow/flatten/index.js';
import type { WorkflowGroup } from '../../workflow/workflowGroups.js';
import { collectMediaFields } from './mediaFields.js';
import { collectNegativeOriginNodeIds } from './negativeEncoders.js';
import { collectPrimitiveCandidates } from './primitiveCandidates.js';
import { collectWidgetWalkCandidates } from './widgetWalkCandidates.js';
import { collectProxyPromoteCandidates } from './proxyPromoteCandidates.js';
import { mergeCandidates } from './merge.js';
import { detectModeFields } from './modeDetect.js';
import type { FormFieldCandidate, FormFieldPlan } from './types.js';
import type { FormInputData, RawTemplate } from '../types.js';

export type { FormFieldPlan } from './types.js';

const PROMPT_TAG_TRIGGERS = new Set([
  'Text to Image', 'Text to Video', 'Text to Audio', 'Image Edit',
  'Image to Video', 'Text to Model', 'Text to Speech', 'Video Edit',
  'Style Transfer', 'Inpainting', 'Outpainting', 'Relight',
  'ControlNet', 'Image', 'Video', 'API',
]);

function defaultPromptCandidate(description?: string): FormFieldCandidate {
  return {
    id: 'prompt',
    label: 'Prompt',
    type: 'textarea',
    required: true,
    description,
    placeholder: 'Describe what you want to generate...',
    source: 'tag-fallback',
  };
}

function tryFlatten(
  workflow: Record<string, unknown> | undefined,
): { nodes: Map<string, FlatNode>; links: FlatLink[] } {
  if (!workflow) return { nodes: new Map(), links: [] };
  try { return flattenWorkflow(workflow); } catch { return { nodes: new Map(), links: [] }; }
}

/**
 * Build the canonical plan. Order of collectors matters — Rule A in `merge`
 * uses input order as the tiebreaker on equal precedence, and the published
 * field order is the order of survival. Media uploads come LAST because the
 * UI renders prompt fields above uploads (matches pre-redesign behaviour).
 */
export function buildFormFieldPlan(
  template: RawTemplate,
  workflow?: Record<string, unknown>,
  objectInfo?: Record<string, Record<string, unknown>>,
): FormFieldPlan {
  const flat = tryFlatten(workflow);
  const flatNodes = flat.nodes;
  const negativeIds = collectNegativeOriginNodeIds(flat.nodes, flat.links);
  const candidates: FormFieldCandidate[] = [];

  if (workflow) {
    candidates.push(...collectPrimitiveCandidates(flatNodes, flat.links));
    if (objectInfo) {
      candidates.push(...collectWidgetWalkCandidates(flatNodes, objectInfo, negativeIds));
      candidates.push(...collectProxyPromoteCandidates(workflow, flatNodes, objectInfo, negativeIds));
    }
  }

  const promptish = candidates.filter(c => c.type === 'textarea');
  const hasMedia = (template.io?.inputs ?? []).some(i =>
    i.mediaType === 'image' || i.mediaType === 'audio' || i.mediaType === 'video',
  );

  // Tag-only fallback: when no prompt-surface candidate showed up, emit the
  // legacy unbound generic prompt — but only when the template either has no
  // media uploads (so the form would otherwise be empty) or its tags say a
  // prompt is expected (matches pre-redesign behaviour).
  if (promptish.length === 0) {
    const needsPrompt = (template.tags?.some(t => PROMPT_TAG_TRIGGERS.has(t))) ?? false;
    if (!hasMedia || needsPrompt) {
      candidates.push(defaultPromptCandidate(template.description));
    }
  }

  candidates.push(...collectMediaFields(template, workflow, flat));

  const merged = mergeCandidates(candidates, flatNodes);
  let fields = merged.fields;

  // Final safety net: if every candidate path was empty (no workflow, no
  // media, no triggers), surface the unbound generic prompt so the form
  // isn't blank. Mirrors the legacy "if (inputs.length === 0)" fallback.
  if (fields.length === 0) fields = [stripSource(defaultPromptCandidate())];

  // Mode-detection: prepend the mode-select (if detected) and append any
  // bypass-toggle fields. These are injected after the merge pipeline so
  // they bypass the deduplicate / precedence logic — they're topology controls
  // not widget bindings. They do still pass assertInvariants (unique ids +
  // no competing (bindNodeId, bindWidgetName) pair).
  if (workflow) {
    const { modeSelect, bypassToggles } = detectModeFields(workflow);
    if (modeSelect) {
      // Tag each regular field with the mode(s) it belongs to. For v1 we
      // don't have fine-grained reachability analysis, so all regular fields
      // remain always-visible (modeRequired stays unset). A future pass can
      // add per-subgraph tagging by tracing which subgraph's proxyWidgets
      // each field's bindNodeId resolves to.
      fields = [modeSelect as FormInputData, ...fields];
    }
    if (bypassToggles.length > 0) {
      fields = [...fields, ...bypassToggles as FormInputData[]];
    }
  }

  assertInvariants(fields);
  return { fields, claimSet: merged.claimSet };
}

function stripSource(c: FormFieldCandidate): FormInputData {
  const { source: _source, ...rest } = c;
  void _source;
  return rest as FormInputData;
}

/**
 * Post-merge pass: when two or more fields share the same label, append a
 * group-title disambiguator to each colliding field's label so the user can
 * tell them apart. Format: `"<label> · <group title>"`. Falls back to
 * `"<label> · <bindNodeId>"` when the node isn't in any group.
 *
 * Only touches fields that actually collide — unambiguous fields are left as-is.
 */
export function disambiguateFieldLabels(
  fields: FormInputData[],
  groups: WorkflowGroup[],
): FormInputData[] {
  // Build nodeId -> group title lookup.
  const nodeToGroup = new Map<string, string>();
  for (const g of groups) {
    for (const n of g.nodes) {
      if (!nodeToGroup.has(n.id)) nodeToGroup.set(n.id, g.title);
    }
  }

  // Find labels that appear more than once.
  const labelCounts = new Map<string, number>();
  for (const f of fields) {
    labelCounts.set(f.label, (labelCounts.get(f.label) ?? 0) + 1);
  }

  return fields.map(f => {
    if ((labelCounts.get(f.label) ?? 0) <= 1) return f;
    const groupTitle = f.bindNodeId ? (nodeToGroup.get(f.bindNodeId) ?? f.bindNodeId) : '';
    const disambig = groupTitle ? ` · ${groupTitle}` : '';
    return { ...f, label: `${f.label}${disambig}` };
  });
}

/** Verify the published list is internally consistent. Cheap; runs every
 *  call. Throws on a structural bug so we catch regressions in tests
 *  rather than at end-user request time. */
function assertInvariants(fields: FormInputData[]): void {
  const ids = new Set<string>();
  const binds = new Set<string>();
  for (const f of fields) {
    if (ids.has(f.id)) {
      throw new Error(`form-field-plan invariant: duplicate id ${JSON.stringify(f.id)}`);
    }
    ids.add(f.id);
    if (f.bindNodeId && f.bindWidgetName) {
      const k = `${f.bindNodeId}|${f.bindWidgetName}`;
      if (binds.has(k)) {
        throw new Error(`form-field-plan invariant: duplicate bind ${k}`);
      }
      binds.add(k);
    }
  }
}
