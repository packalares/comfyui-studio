// Primitive shape helpers for the raw-widget pipeline. Kept separate from
// the enumeration / claim logic so individual inference rules can be unit-
// tested without involving the file system or template store.

import type { AdvancedSetting } from '../../../contracts/workflow.contract.js';
import {
  FRONTEND_ONLY_VALUES,
  KNOWN_SETTINGS,
  PRIMITIVE_WIDGET_TYPES,
} from '../constants.js';

/** Is this objectInfo input spec a widget (not a socket connection)? */
export function isWidgetSpec(spec: unknown): boolean {
  if (!Array.isArray(spec) || spec.length === 0) return false;
  const t = spec[0];
  if (Array.isArray(t)) return true; // COMBO list
  if (typeof t === 'string' && PRIMITIVE_WIDGET_TYPES.has(t)) return true;
  return false;
}

/**
 * Walk a class_type's inputs in declaration order and return widget names
 * in the same order as widgets_values.
 */
export function widgetNamesFor(
  objectInfo: Record<string, Record<string, unknown>>,
  classType: string,
): string[] {
  const info = objectInfo[classType] as {
    input?: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  } | undefined;
  if (!info?.input) return [];
  const names: string[] = [];
  for (const [name, spec] of Object.entries(info.input.required || {})) {
    if (isWidgetSpec(spec)) names.push(name);
  }
  for (const [name, spec] of Object.entries(info.input.optional || {})) {
    if (isWidgetSpec(spec)) names.push(name);
  }
  return names;
}

type WidgetShape = Pick<AdvancedSetting, 'type' | 'min' | 'max' | 'step' | 'options'>;

// Shape inference from an explicit objectInfo spec entry. `opts` comes
// from spec[1] (the bounds / multiline flag / default dict / options list).
// Both COMBO shapes land here: legacy form (spec[0] is the options array)
// and modern form (spec[0] === "COMBO", options at spec[1].options).
function shapeFromSpec(
  type: unknown,
  opts: { min?: number; max?: number; step?: number; multiline?: boolean; options?: unknown },
): WidgetShape | null {
  if (Array.isArray(type)) {
    return {
      type: 'select',
      options: type
        .filter(o => typeof o === 'string')
        .map(o => ({ label: String(o), value: String(o) })),
    };
  }
  if (type === 'COMBO') {
    const raw = Array.isArray(opts.options) ? opts.options : [];
    return {
      type: 'select',
      options: raw
        .filter((o): o is string => typeof o === 'string')
        .map(o => ({ label: o, value: o })),
    };
  }
  if (type === 'INT' || type === 'FLOAT') {
    return { type: 'number', min: opts.min, max: opts.max, step: opts.step };
  }
  if (type === 'BOOLEAN') return { type: 'toggle' };
  if (type === 'STRING') {
    return { type: opts.multiline === true ? 'textarea' : 'text' };
  }
  return null;
}

/** Infer UI control + bounds + options for a (classType, widgetName) pair. */
export function inferWidgetShape(
  objectInfo: Record<string, Record<string, unknown>>,
  classType: string,
  widgetName: string,
  value: unknown,
): WidgetShape {
  const known = KNOWN_SETTINGS[widgetName];
  if (known) return { type: known.type ?? 'number', min: known.min, max: known.max, step: known.step };

  const info = objectInfo[classType] as {
    input?: {
      required?: Record<string, [unknown, Record<string, unknown>?]>;
      optional?: Record<string, [unknown, Record<string, unknown>?]>;
    };
  } | undefined;
  const spec = info?.input?.required?.[widgetName] ?? info?.input?.optional?.[widgetName];
  if (Array.isArray(spec)) {
    const t = spec[0];
    const opts = (spec[1] || {}) as { min?: number; max?: number; step?: number; multiline?: boolean; options?: unknown };
    const fromSpec = shapeFromSpec(t, opts);
    if (fromSpec) return fromSpec;
  }
  if (typeof value === 'boolean') return { type: 'toggle' };
  if (typeof value === 'number') return { type: 'number' };
  return { type: 'number' };
}

/**
 * Return widgets_values with ComfyUI's frontend-only injected values
 * removed. Most importantly this strips `control_after_generate`'s value
 * ("randomize" / "fixed" / ...) that the UI inserts after any seed widget
 * but which does NOT appear in objectInfo's input list. Without this
 * filter, widgets after a seed would read wrong values.
 */
export function filteredWidgetValues(wv: unknown[] | undefined): unknown[] {
  if (!Array.isArray(wv)) return [];
  return wv.filter(v => !FRONTEND_ONLY_VALUES.has(v as string));
}
