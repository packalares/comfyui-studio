// Shared constants for the workflow pipeline.
//
// Kept in one file so the individual pipeline modules (flatten / resolve /
// prompt / rawWidgets / proxyLabels / collect) all agree on which widget
// names are hidden, which node types are UI-only, etc. Do not inline copies
// of any of these — update here and every caller picks up the change.

import type { AdvancedSetting } from '../../contracts/workflow.contract.js';

// Widget names to hide from advanced settings.
export const HIDDEN_WIDGET_NAMES = new Set<string>([
  'text', 'prompt', 'control_after_generate',
]);

// Patterns in widget names that indicate model files (hide these).
export const MODEL_NAME_PATTERNS = [
  'model', 'unet', 'clip', 'vae', 'lora', 'checkpoint', 'ckpt',
];

// Widget names that carry no semantic info by themselves — common generic slot
// names on wrapper nodes. When we hit one, prefer the source node title.
export const BLAND_WIDGET_NAMES = new Set<string>([
  'value', 'enabled', 'on', 'off', 'bool', 'active', 'input',
]);

// Known setting defaults for common widget names.
export const KNOWN_SETTINGS: Record<string, Partial<AdvancedSetting>> = {
  width:      { type: 'number', min: 64, max: 4096, step: 64 },
  height:     { type: 'number', min: 64, max: 4096, step: 64 },
  steps:      { type: 'slider', min: 1, max: 100, step: 1 },
  seed:       { type: 'seed' },
  noise_seed: { type: 'seed' },
  length:     { type: 'slider', min: 1, max: 300, step: 1 },
  cfg:        { type: 'slider', min: 1, max: 30, step: 0.5 },
  denoise:    { type: 'slider', min: 0, max: 1, step: 0.05 },
  shift:      { type: 'slider', min: 0, max: 100, step: 0.1 },
};

// Known loader node types that reference model filenames in widgets_values.
export const LOADER_TYPES = new Set<string>([
  'UNETLoader',
  'VAELoader',
  'CLIPLoader',
  'LoraLoaderModelOnly',
  'CheckpointLoaderSimple',
  'LoraLoader',
  'DualCLIPLoader',
]);

// Primitive widget types always treated as widget values in the API pass.
export const WIDGET_PRIMITIVES = new Set<string>([
  'INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO',
]);

// Strict primitives used to decide whether an objectInfo input spec is a
// widget (raw-widget enumeration path — stricter than WIDGET_PRIMITIVES).
export const PRIMITIVE_WIDGET_TYPES = new Set<string>([
  'INT', 'FLOAT', 'STRING', 'BOOLEAN',
]);

// Node types that exist only in the UI graph and must never appear in the
// emitted API prompt. Their contribution is inlined during resolve/flatten.
export const UI_ONLY_TYPES = new Set<string>([
  'Reroute',
  'PrimitiveNode',
  'PrimitiveInt',
  'PrimitiveFloat',
  'PrimitiveBoolean',
  'PrimitiveString',
  'PrimitiveStringMultiline',
  'GetNode',
  'SetNode',
  'easy getNode',
  'easy setNode',
]);

// Frontend-only widget values that appear in widgets_values but not in the
// API schema. Must be stripped before index-aligning with widgetNamesFor().
export const FRONTEND_ONLY_VALUES = new Set<string>([
  'randomize', 'fixed', 'increment', 'decrement',
]);

// Shared helper — Title Case a snake_case / camelCase-ish widget name.
export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Hidden-widget filter used by advanced-settings extraction.
export function isHiddenWidget(widgetName: string): boolean {
  if (HIDDEN_WIDGET_NAMES.has(widgetName)) return true;
  const lower = widgetName.toLowerCase();
  if (lower.endsWith('_name') && MODEL_NAME_PATTERNS.some(p => lower.includes(p))) return true;
  if (MODEL_NAME_PATTERNS.some(p => lower === p)) return true;
  return false;
}

// Hidden-widget filter for the "expose fields" enumeration. Mirrors
// isHiddenWidget but leaves 'text' / 'prompt' visible so users can surface
// them intentionally.
export function isEnumerableWidget(widgetName: string): boolean {
  const lower = widgetName.toLowerCase();
  if (lower.endsWith('_name') && MODEL_NAME_PATTERNS.some(p => lower.includes(p))) return false;
  if (MODEL_NAME_PATTERNS.some(p => lower === p)) return false;
  return true;
}
