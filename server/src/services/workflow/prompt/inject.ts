// Post-emission mutation passes: formInput uploads, user-prompt injection,
// seed randomisation, and the PrimitiveString* pre-flatten seeding that
// carries user prompts through inlined UI-only nodes.

import type { FormInputBinding } from '../../../contracts/workflow.contract.js';
import type { FlatNode } from '../flatten/index.js';
import type { ApiPrompt } from './types.js';

/**
 * Write user-uploaded image/audio/video onto its declared node. The extra
 * `upload` key mirrors what ComfyUI's UI-format encodes via
 * `widgets_values[1]`. ComfyUI's `/api/prompt` validator silently ignores
 * unknown keys, so including it is harmless but non-canonical. Strip it
 * only if you need byte-identical output to the official exporter.
 */
export function applyFormInputs(
  prompt: ApiPrompt,
  formInputs: FormInputBinding[],
  userInputs: Record<string, unknown>,
): void {
  for (const binding of formInputs) {
    const val = userInputs[binding.id];
    if (binding.nodeId == null) continue;
    const isMedia = binding.mediaType === 'image'
      || binding.mediaType === 'audio'
      || binding.mediaType === 'video';
    // Empty media field → the user declined the upload (allowed when the
    // downstream socket is optional). Remove the LoadImage/Audio/Video
    // node from the API prompt AND any `[<id>, <slot>]` refs on other
    // nodes so ComfyUI doesn't try to validate a loader pointing at a
    // missing file. Non-media bindings fall through to `continue` as
    // before — empty literals preserve the workflow's baked-in default.
    if (val == null || val === '') {
      if (isMedia) removeNodeAndRefs(prompt, String(binding.nodeId));
      continue;
    }
    const entry = prompt[String(binding.nodeId)];
    if (!entry) continue;
    if (binding.mediaType === 'image') {
      entry.inputs.image = val;
      entry.inputs.upload = 'image';
    } else if (binding.mediaType === 'audio') {
      entry.inputs.audio = val;
      entry.inputs.upload = 'audio';
    } else if (binding.mediaType === 'video') {
      entry.inputs.video = val;
      entry.inputs.upload = 'video';
    }
  }
}

/**
 * Strip a node from the API prompt and scrub every reference to it from
 * any other node's inputs. References in ComfyUI's API-prompt format are
 * `[nodeId, slot]` tuples. Dropping the input key (rather than leaving a
 * dangling ref) is what ComfyUI expects — optional sockets accept "not
 * supplied" but not "supplied as dangling link".
 */
function removeNodeAndRefs(prompt: ApiPrompt, nodeId: string): void {
  if (!prompt[nodeId]) return;
  delete prompt[nodeId];
  for (const entry of Object.values(prompt)) {
    const inputs = entry.inputs ?? {};
    for (const key of Object.keys(inputs)) {
      const v = inputs[key];
      if (Array.isArray(v) && v.length === 2 && String(v[0]) === nodeId) {
        delete inputs[key];
      }
    }
  }
}

/**
 * Write each (bindNodeId, bindWidgetName, value) binding onto the API
 * prompt. Preserves the wire-guard (upstream `[id, slot]` array wins) and
 * skips empty-string values so "user left the field blank" keeps the
 * workflow's baked-in default. Returns the covered `${nodeId}|${widget}`
 * keys so the legacy fan-out can skip them.
 */
export function applyBoundFormInputs(
  prompt: ApiPrompt,
  _nodes: Map<string, FlatNode>,
  bindings: Array<{ bindNodeId: string; bindWidgetName: string; value: unknown }>,
): Set<string> {
  const covered = new Set<string>();
  for (const b of bindings) {
    const entry = prompt[b.bindNodeId];
    if (!entry) continue;
    const key = `${b.bindNodeId}|${b.bindWidgetName}`;
    // Wire wins over literal; still mark covered so the legacy fan-out
    // doesn't rewrite the same widget literal-over-wire.
    if (Array.isArray(entry.inputs[b.bindWidgetName])) { covered.add(key); continue; }
    if (b.value === undefined || b.value === null) continue;
    if (typeof b.value === 'string' && b.value.length === 0) continue;
    entry.inputs[b.bindWidgetName] = b.value;
    covered.add(key);
  }
  return covered;
}

// Widget names that commonly carry the USER PROMPT on text-encoder nodes.
// Matches ComfyUI's prompt-input conventions: CLIPTextEncode (`text`),
// CLIPTextEncodeFlux (`clip_l` + `t5xxl`), CLIPTextEncodeSDXL (`text_g`
// + `text_l`), and ACE-Step audio (`lyrics`/`tags` are technically
// separate channels but users put prompt-like text into both). The match
// is against widget NAME, not widget type — nodes like
// `ComfyMathExpression.expression` are also multiline STRING but have
// semantics unrelated to prompt text and must not receive it.
const PROMPT_WIDGET_NAMES = new Set<string>([
  'text', 'prompt',
  'clip_l', 't5xxl',
  'text_g', 'text_l',
  'positive_prompt',
  // Audio (ACE Step + variants): the "tags" widget carries genre/style
  // tags, and "lyrics" carries words. Both are the natural landing
  // surface for the user's generic prompt field on audio workflows.
  'tags', 'lyrics',
]);

// Collect prompt-role widget names on a class_type — only those that are
// both declared as STRING inputs AND named per the convention above.
function promptTargetsFor(
  objectInfo: Record<string, Record<string, unknown>>,
  classType: string,
): string[] {
  const schema = objectInfo[classType] as {
    input?: {
      required?: Record<string, unknown>;
      optional?: Record<string, unknown>;
    };
  } | undefined;
  const inputs = { ...(schema?.input?.required || {}), ...(schema?.input?.optional || {}) };
  const targets: string[] = [];
  for (const [name, spec] of Object.entries(inputs)) {
    if (!PROMPT_WIDGET_NAMES.has(name)) continue;
    if (!Array.isArray(spec) || spec[0] !== 'STRING') continue;
    targets.push(name);
  }
  return targets;
}

/**
 * Inject the user's prompt into EXACTLY ONE node — the first
 * non-negative-titled node with prompt-role widgets. Every such widget
 * on that one node receives the prompt text, then we stop.
 *
 * Matching is name-based (see PROMPT_WIDGET_NAMES) so that other
 * multiline-STRING widgets (e.g. math expression bodies) aren't
 * collaterally targeted.
 *
 * Fallback for flat workflows without a Prompt-titled PrimitiveStringMultiline;
 * modern subgraph workflows route through `applyPrimitiveOverrides`, which
 * already hits the canonical Prompt Primitive before this function runs.
 * Primitive `value` isn't in PROMPT_WIDGET_NAMES, so we don't double-write
 * — the Primitive override remains authoritative.
 */
export function injectUserPrompt(
  prompt: ApiPrompt,
  nodes: Map<string, FlatNode>,
  objectInfo: Record<string, Record<string, unknown>>,
  promptText: string,
): void {
  for (const [id, nodeData] of Object.entries(prompt)) {
    const node = nodes.get(id);
    if (!node) continue;
    const title = (node.title || '') as string;
    if (/negative/i.test(title)) continue;
    const targets = promptTargetsFor(objectInfo, node.type);
    if (targets.length === 0) continue;
    let wroteAny = false;
    for (const name of targets) {
      // Wire guard: when an input is already `[nodeId, slot]`, the value
      // comes from an upstream node — overwriting it breaks the routing.
      // LTX-2.3 runs its prompt through TextGenerateLTX2Prompt (Gemma
      // expansion) before CLIPTextEncode; replacing the wire with a
      // literal bypasses Gemma and degrades i2v conditioning to
      // first-frame-only. Modern workflows route the user prompt through
      // `applyPrimitiveOverrides` into a titled PrimitiveStringMultiline;
      // that value then flows down the same wire this guard protects.
      if (Array.isArray(nodeData.inputs[name])) continue;
      nodeData.inputs[name] = promptText;
      wroteAny = true;
    }
    // Only stop at the first node we actually wrote something to. A node
    // where every target was already wired doesn't count — keep scanning
    // so a downstream literal target (classic flat workflows) still gets
    // the user's prompt.
    if (wroteAny) break;
  }
}

/**
 * Randomise seed for samplers so repeated runs don't produce identical
 * outputs. Applied BEFORE user nodeOverrides so user-set seeds win.
 */
export function randomizeSeeds(prompt: ApiPrompt): void {
  for (const nodeData of Object.values(prompt)) {
    if (nodeData.class_type === 'KSampler' || nodeData.class_type === 'RandomNoise') {
      const seedKey = nodeData.class_type === 'RandomNoise' ? 'noise_seed' : 'seed';
      nodeData.inputs[seedKey] = Math.floor(Math.random() * 2147483647);
    }
  }
}

/**
 * Post-emit: apply user edits from Primitive-derived form fields onto the
 * corresponding Primitive* node in the API prompt. Field ids produced by
 * the form-field plan's primitive collector are either:
 *   - `prompt`          → the Primitive titled "Prompt" (by convention).
 *   - `primitive:<id>`  → a specific Primitive node by its inner id.
 *
 * The emitted compound id looks like `<wrapperId>:<innerId>` for subgraph
 * nodes or just `<innerId>` for top-level ones. We match on the inner id
 * (everything after the last `:`). Literal `PrimitiveNode` (legacy, no
 * suffix) isn't a real node in modern ComfyUI — it's still inlined via
 * resolveInput — so we skip it here.
 */
const PRIMITIVE_CLASS_TYPES = new Set<string>([
  'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean',
  'PrimitiveString', 'PrimitiveStringMultiline',
]);

function innerIdOf(compoundId: string): string {
  const colon = compoundId.lastIndexOf(':');
  return colon < 0 ? compoundId : compoundId.slice(colon + 1);
}

function coerceToWidgetType(value: unknown, classType: string): unknown {
  if (value === null || value === undefined) return value;
  if (classType === 'PrimitiveBoolean') return Boolean(value);
  if (classType === 'PrimitiveInt') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : value;
  }
  if (classType === 'PrimitiveFloat') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return String(value);
}

export function applyPrimitiveOverrides(
  prompt: ApiPrompt,
  userInputs: Record<string, unknown>,
): void {
  for (const [compoundId, entry] of Object.entries(prompt)) {
    if (!PRIMITIVE_CLASS_TYPES.has(entry.class_type)) continue;
    const title = ((entry._meta as { title?: unknown } | undefined)?.title as string | undefined) ?? '';
    const innerId = innerIdOf(compoundId);

    // Prompt-role resolution: a PrimitiveStringMultiline titled "Prompt"
    // (case-insensitive) maps to the user's generic `prompt` form field.
    let userVal: unknown = undefined;
    if (/^prompt$/i.test(title.trim()) && 'prompt' in userInputs) {
      const raw = userInputs.prompt;
      // Empty prompt = "user didn't type anything" → keep the workflow's
      // baked-in default. Callers that actually want to blank the prompt
      // can target it via `primitive:<id>` below.
      if (typeof raw === 'string' && raw.length === 0) {
        userVal = undefined;
      } else {
        userVal = raw;
      }
    }
    // Either way, an id-specific override always wins (so a user-imported
    // workflow with two PrimitiveStringMultiline nodes — one titled Prompt,
    // one titled "System Prompt" — can be edited independently).
    const byIdKey = `primitive:${innerId}`;
    if (byIdKey in userInputs) userVal = userInputs[byIdKey];
    if (userVal === undefined || userVal === null) continue;
    if (typeof userVal === 'string' && userVal.length === 0
        && entry.class_type !== 'PrimitiveString' && entry.class_type !== 'PrimitiveStringMultiline') {
      // Empty-string doesn't make sense for numeric/bool Primitives.
      continue;
    }
    entry.inputs.value = coerceToWidgetType(userVal, entry.class_type);
  }
}
