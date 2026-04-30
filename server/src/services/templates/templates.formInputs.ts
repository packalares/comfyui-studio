// Public form-input API. Thin wrapper over the canonical
// `buildFormFieldPlan` pipeline in `formFieldPlan/`. All routing logic
// (Primitive walk, widget walk, proxy promotion, dedup, tag fallback)
// lives in that subdirectory; this file exists to keep the existing
// import path stable for callers (`generateFormInputs`).

import { buildFormFieldPlan } from './formFieldPlan/index.js';
import type { FormInputData, RawTemplate } from './types.js';

/**
 * Build the form-input list for a template. `objectInfo` is required for the
 * widget-walk + proxy-promote paths; pass an empty object when no workflow
 * is available (the function falls through to the tag-only prompt fallback).
 *
 * Outputs from this function flow into:
 *   - `/template-widgets` response (`primitiveFormFields` array → UI form)
 *   - `applyBoundFormInputs` at submit time (each field's `bindNodeId` +
 *     `bindWidgetName` is the routing target for the user's value)
 *   - `computeFormClaimedWidgets` (every bound field auto-claims its
 *     widget so it doesn't double-render in Advanced Settings)
 */
export function generateFormInputs(
  template: RawTemplate,
  workflow?: Record<string, unknown>,
  objectInfo?: Record<string, Record<string, unknown>>,
): FormInputData[] {
  return buildFormFieldPlan(template, workflow, objectInfo).fields;
}
