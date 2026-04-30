// Canonical types for the form-field plan pipeline.
//
// `FormFieldCandidate` is the internal shape produced by each collector.
// `FormFieldPlan` is what `buildFormFieldPlan` returns to consumers.

import type { FormInputData } from '../types.js';

export type FieldSource =
  | 'media-upload'
  | 'primitive'
  | 'widget-walk'
  | 'proxy-promote'
  | 'tag-fallback';

/** Provenance + final shape rolled into one. The orchestrator strips
 *  `source` before publishing to consumers. */
export interface FormFieldCandidate extends FormInputData {
  source: FieldSource;
}

/** Single struct shared by `/template-widgets`, `/workflow-settings`, and
 *  the dedup filter so all three reason about the same set of bound widgets. */
export interface FormFieldPlan {
  /** Ordered list of form fields ready for the UI. No duplicates by
   *  `id`, no duplicates by `(bindNodeId, bindWidgetName)`. */
  fields: FormInputData[];
  /** `${bindNodeId}|${bindWidgetName}` keys for every bound field.
   *  Authoritative input to `formClaimed` / Advanced-Settings dedup. */
  claimSet: Set<string>;
}

/** Source-precedence table: higher number wins. Media uploads dominate
 *  because they're the only path that owns nodeId-to-file binding; primitive
 *  walk dominates widget-walk because it carries the author's chosen title. */
export const SOURCE_PRECEDENCE: Record<FieldSource, number> = {
  'media-upload': 5,
  primitive: 4,
  'widget-walk': 3,
  'proxy-promote': 2,
  'tag-fallback': 1,
};
