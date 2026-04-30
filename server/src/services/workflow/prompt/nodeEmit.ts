// Phase 2 of the API-prompt pipeline: emit one prompt entry per real node.
// UI-only types are skipped (their contribution inlines via resolveInput),
// muted nodes (mode 2) are defensively skipped, and any class_type we
// don't have objectInfo for is silently dropped.
//
// Widget emission handles V3 meta-widget types (COMFY_DYNAMICCOMBO_V3,
// COMFY_AUTOGROW_V3) alongside classic V1 widgets (INT/FLOAT/STRING/
// BOOLEAN/COMBO). V3 DynamicCombo expands into flat dotted-key siblings
// (`<name>: <mode>`, `<name>.<sub>: <val>`) that ComfyUI's server re-nests
// via `build_nested_inputs()`. See server's `comfy_api/latest/_io.py`.

import {
  FRONTEND_ONLY_VALUES, UI_ONLY_TYPES, V3_WIDGET_TYPES, WIDGET_PRIMITIVES,
} from '../constants.js';
import type { FlatNode } from '../flatten/index.js';
import { resolveInput, type ResolveCtx } from '../resolve.js';
import type { ApiPrompt } from './types.js';

interface WidgetSpec {
  name: string;
  /** Concrete type string (e.g. "INT", "COMFY_DYNAMICCOMBO_V3") or null when the
   *  spec[0] is an inline array of options (plain COMBO). */
  type: string | null;
  /** spec[1] — the options bag (min/max/multiline/default/options/etc.) */
  cfg: Record<string, unknown> | null;
  /** When spec[0] is an inline array of option strings (plain COMBO), this
   *  carries them so we can case-normalise stored values against the allowed
   *  list (e.g. "True" -> "true"). */
  inlineOptions?: string[];
}

/**
 * Walk the required+optional inputs of a node type and return the widget
 * entries — i.e. the inputs that CAN carry a widget value rather than a
 * typed-socket connection. Sockets (uppercase types NOT in WIDGET_PRIMITIVES
 * or V3_WIDGET_TYPES) are excluded. An inline COMBO array (`spec[0]` is an
 * array of string options) counts as a widget.
 */
export function getApiWidgetSpecs(
  objectInfo: Record<string, Record<string, unknown>>,
  classType: string,
): WidgetSpec[] {
  const info = objectInfo[classType] as {
    input?: {
      required?: Record<string, unknown[]>;
      optional?: Record<string, unknown[]>;
    };
  } | undefined;
  if (!info?.input) return [];
  const out: WidgetSpec[] = [];
  // Walk required first, then optional. Required-first preserves widget order
  // matching `widgets_values[]` positional encoding in workflow JSON. Many
  // custom nodes (comfyui_controlnet_aux AIO_Preprocessor, several LTX/KJ
  // nodes) declare COMBO/INT widgets under `optional` purely as a UI
  // convention, while their Python `execute()` still requires them as
  // positional kwargs. Skipping `optional` causes silent prompt-input drops
  // and "missing required positional argument" errors at execution. The
  // sibling walker `widgetNamesFor` in `rawWidgets/shapes.ts:37-42` already
  // walks both buckets — this aligns the two.
  const rows: Array<[string, unknown[]]> = [
    ...Object.entries(info.input.required || {}),
    ...Object.entries(info.input.optional || {}),
  ];
  for (const [name, spec] of rows) {
    if (!Array.isArray(spec) || spec.length === 0) continue;
    const rawType = spec[0];
    const cfg = (spec[1] as Record<string, unknown> | undefined) ?? null;
    if (Array.isArray(rawType)) {
      // Inline COMBO array (e.g. ['a', 'b', 'c']) — widget. Carry the
      // allowed options list so the emitter can normalise stored values
      // (see `normaliseComboValue`).
      const inlineOptions = rawType.filter((o): o is string => typeof o === 'string');
      out.push({ name, type: null, cfg, inlineOptions });
      continue;
    }
    if (typeof rawType === 'string') {
      const type = rawType;
      const isWidget =
        WIDGET_PRIMITIVES.has(type) || V3_WIDGET_TYPES.has(type)
        || !(type === type.toUpperCase());
      if (!isWidget) continue; // uppercase socket type (CLIP, MODEL, VAE, ...)
      out.push({ name, type, cfg });
    }
  }
  return out;
}

/**
 * Back-compat helper — returns just the widget names (old signature). New
 * callers should prefer `getApiWidgetSpecs` since it carries type + cfg.
 */
export function getApiWidgetNames(
  objectInfo: Record<string, Record<string, unknown>>,
  classType: string,
): string[] {
  return getApiWidgetSpecs(objectInfo, classType).map(w => w.name);
}

/**
 * Case-normalise a string against a set of allowed options. When the
 * stored value matches an option case-insensitively but not exactly,
 * return the option in its canonical case. If no match is found OR the
 * value isn't a string, return it unchanged (ComfyUI's validator will
 * reject it downstream with a readable error).
 *
 * Handles the common "True" / "true", "False" / "false", and
 * differently-cased enum entries that workflows saved by older ComfyUI
 * versions sometimes carry.
 */
function normaliseComboValue(value: unknown, options: string[] | undefined): unknown {
  if (typeof value !== 'string' || !options || options.length === 0) return value;
  if (options.includes(value)) return value;
  const lower = value.toLowerCase();
  const match = options.find(o => o.toLowerCase() === lower);
  return match !== undefined ? match : value;
}

/**
 * Pull a positional value from `widgets_values`. Some custom node packs
 * (rgthree Power LoRA Loader etc.) serialise widgets_values as a DICT
 * instead of a list — schema-ordered lookup is identical in both cases
 * when we pass the widget name alongside the index.
 *
 * `fallbackName` is used only for V3 DynamicCombo sub-inputs where the
 * emitter expects dotted keys like `sampling_mode.temperature` but the
 * dict form stores them under their bare name (`temperature`). When the
 * primary dotted lookup misses, the fallback short name is tried before
 * giving up. Unused for array form.
 */
function readWidgetValue(
  wv: unknown[] | Record<string, unknown>,
  index: number,
  name: string,
  fallbackName?: string,
): unknown {
  if (Array.isArray(wv)) return wv[index];
  if (wv && typeof wv === 'object') {
    const rec = wv as Record<string, unknown>;
    if (name in rec) return rec[name];
    if (fallbackName && fallbackName in rec) return rec[fallbackName];
  }
  return undefined;
}

// For a V3 DynamicCombo widget, resolve the currently-selected option and
// return both the sub-input names (in order) AND the sub-input specs. The
// caller previously re-did `options.find(o => o?.key === selectedKey)` just
// to read `match.inputs.required` for default-value lookup; bundling the
// specs here avoids the duplicate traversal. `cfg` is spec[1]; sub-inputs
// live under `options[<n>].inputs.required` per the V3 serialization
// contract.
function dynamicComboSubInputs(
  cfg: Record<string, unknown> | null,
  selectedKey: unknown,
): { names: string[]; subSpecs: Record<string, unknown> } {
  const empty = { names: [] as string[], subSpecs: {} as Record<string, unknown> };
  if (!cfg) return empty;
  const options = cfg.options as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(options)) return empty;
  const match = options.find(o => o?.key === selectedKey);
  if (!match) return empty;
  const inputs = (match.inputs as { required?: Record<string, unknown> } | undefined)?.required;
  if (!inputs || typeof inputs !== 'object') return empty;
  return { names: Object.keys(inputs), subSpecs: inputs as Record<string, unknown> };
}

/**
 * Consume one widget from the positional widgets_values iterator and write
 * the corresponding API-input entries into `inputs`. Returns the number of
 * wv positions consumed (caller advances).
 *
 * V3 DynamicCombo: consumes 1 + (option's sub-input count) positions, emits
 *   `<name>: mode` + `<name>.<sub>: value` per sub-input.
 * V3 Autogrow: consumes 0 positions — link-bound sub-entries are handled
 *   entirely by the first-pass node.inputs walk. Literal Autogrow values
 *   aren't supported here (no known workflow uses them at position-level).
 * Everything else: consumes 1 position, emits `<name>: value`.
 *
 * If a target key is already set in `inputs` (because the first-pass link
 * resolution wrote it), the wv position is still consumed but the literal
 * is discarded — the wire wins.
 */
function consumeWidget(
  widget: WidgetSpec,
  wv: unknown[] | Record<string, unknown>,
  wvIdx: number,
  inputs: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
): number {
  if (widget.type === 'COMFY_DYNAMICCOMBO_V3') {
    const mode = readWidgetValue(wv, wvIdx, widget.name);
    const consumedHere = 1;
    const overrideKey = widget.name;
    if (!(widget.name in inputs)) {
      inputs[widget.name] =
        overrides && overrideKey in overrides ? overrides[overrideKey] : mode;
    }
    const { names: subs, subSpecs } = dynamicComboSubInputs(widget.cfg, mode);
    for (let i = 0; i < subs.length; i++) {
      const subName = subs[i];
      const dotted = `${widget.name}.${subName}`;
      const subVal = readWidgetValue(wv, wvIdx + 1 + i, dotted, subName);
      if (dotted in inputs) continue;
      if (overrides && dotted in overrides) {
        inputs[dotted] = overrides[dotted];
        continue;
      }
      if (subVal !== undefined) {
        inputs[dotted] = subVal;
        continue;
      }
      const subSpec = subSpecs[subName] as unknown[] | undefined;
      const subCfg = subSpec?.[1] as Record<string, unknown> | undefined;
      if (subCfg && 'default' in subCfg) inputs[dotted] = subCfg.default;
    }
    return consumedHere + subs.length;
  }
  if (widget.type === 'COMFY_AUTOGROW_V3') {
    // Variable-length list widget — its sub-entries arrive as pre-dotted
    // `<name>.a`, `<name>.b`, ... entries in node.inputs (link-bound) and
    // have already been handled by the first-pass walker. Nothing to do
    // positionally in widgets_values.
    return 0;
  }
  // Classic V1 widget (INT/FLOAT/STRING/BOOLEAN/COMBO or inline COMBO array).
  const raw = readWidgetValue(wv, wvIdx, widget.name);
  const value = widget.inlineOptions
    ? normaliseComboValue(raw, widget.inlineOptions)
    : raw;
  if (!(widget.name in inputs)) {
    if (overrides && widget.name in overrides) {
      inputs[widget.name] = overrides[widget.name];
    } else if (value !== undefined) {
      inputs[widget.name] = value;
    } else if (widget.cfg && 'default' in widget.cfg) {
      inputs[widget.name] = widget.cfg.default;
    }
  }
  return 1;
}

// Build the inputs dict for a single API prompt entry by walking node
// inputs (resolveInput handles pass-through chains) and then filling in
// widget values via the V3-aware walker.
function buildNodeInputs(
  node: FlatNode,
  objectInfo: Record<string, Record<string, unknown>>,
  ctx: ResolveCtx,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  // Phase 1 — link-bound inputs (including dotted-key V3 sub-inputs that
  // the workflow promotes to `node.inputs` when they're wired).
  for (const inp of node.inputs) {
    if (inp.link == null) continue;
    const resolved = resolveInput(inp.link, ctx);
    if (!resolved) continue;
    inputs[inp.name] = resolved.kind === 'literal'
      ? resolved.value
      : [resolved.nodeId, resolved.slot];
  }

  // Phase 2 — positional widget walk via the V3-aware consumer.
  const widgets = getApiWidgetSpecs(objectInfo, node.type);
  // widgets_values is usually an array but rgthree / power-lora-loader
  // style custom nodes serialise it as a dict. Preserve whichever shape
  // we got — `readWidgetValue` inside consumeWidget handles both.
  const rawWv = node.widgets_values as unknown;
  const wv: unknown[] | Record<string, unknown> = Array.isArray(rawWv)
    ? rawWv.filter(v => !FRONTEND_ONLY_VALUES.has(v as string))
    : (rawWv && typeof rawWv === 'object' ? rawWv as Record<string, unknown> : []);
  let wvIdx = 0;
  for (const widget of widgets) {
    wvIdx += consumeWidget(widget, wv, wvIdx, inputs, node.overrides);
  }
  return inputs;
}

// Pick the node's display title — prefer user-set `title`, fall back to
// objectInfo `display_name`, then the class_type itself.
function pickDisplayTitle(
  node: FlatNode,
  info: Record<string, unknown>,
): string {
  return node.title?.trim()
    || ((info as { display_name?: string } | undefined)?.display_name)
    || node.type;
}

/** Emit one API prompt entry per real node. */
export function emitNodesFromWorkflow(
  nodes: Map<string, FlatNode>,
  objectInfo: Record<string, Record<string, unknown>>,
  ctx: ResolveCtx,
): ApiPrompt {
  const prompt: ApiPrompt = {};
  for (const [id, node] of nodes.entries()) {
    if (UI_ONLY_TYPES.has(node.type)) continue;
    if (node.mode === 2) continue;
    const info = objectInfo[node.type];
    if (!info) continue;
    const inputs = buildNodeInputs(node, objectInfo, ctx);
    prompt[id] = {
      class_type: node.type,
      inputs,
      _meta: { title: pickDisplayTitle(node, info) },
    };
  }
  return prompt;
}
