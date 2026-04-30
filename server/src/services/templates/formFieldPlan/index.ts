// Single canonical entry point for form-field generation.
//
// `buildFormFieldPlan` returns `{fields, claimSet}` in one pass. Every
// consumer (`/template-widgets`, `/workflow-settings`, the dedup filter,
// the form-claimed widget set) reads from this struct so all of them
// reason about the SAME bound widgets — no more drift between
// `generateFormInputs` and `computeFormClaimedWidgets`.

import { flattenWorkflow, type FlatLink, type FlatNode } from '../../workflow/flatten/index.js';
import { collectMediaFields } from './mediaFields.js';
import { collectNegativeOriginNodeIds } from './negativeEncoders.js';
import { collectPrimitiveCandidates } from './primitiveCandidates.js';
import { collectWidgetWalkCandidates } from './widgetWalkCandidates.js';
import { collectProxyPromoteCandidates } from './proxyPromoteCandidates.js';
import { mergeCandidates } from './merge.js';
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
    candidates.push(...collectPrimitiveCandidates(flatNodes));
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

  candidates.push(...collectMediaFields(template, workflow));

  const merged = mergeCandidates(candidates, flatNodes);
  let fields = merged.fields;

  // Final safety net: if every candidate path was empty (no workflow, no
  // media, no triggers), surface the unbound generic prompt so the form
  // isn't blank. Mirrors the legacy "if (inputs.length === 0)" fallback.
  if (fields.length === 0) fields = [stripSource(defaultPromptCandidate())];

  assertInvariants(fields);
  return { fields, claimSet: merged.claimSet };
}

function stripSource(c: FormFieldCandidate): FormInputData {
  const { source: _source, ...rest } = c;
  void _source;
  return rest as FormInputData;
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
