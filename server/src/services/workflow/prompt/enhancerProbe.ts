// Inject synthetic `PreviewAny` probe nodes downstream of every
// `TextGenerate*` node so ComfyUI broadcasts each enhanced text via the
// `executed` WS event AND surfaces it in `/history` outputs.
//
// PreviewAny ships in ComfyUI core (`comfy_extras/nodes_preview_any.py`):
// `OUTPUT_NODE = True`, returns `{"ui": {"text": (value,)}, "result": ...}`.
// That tells ComfyUI to add the resolved string to the history entry's
// `outputs[<probeId>].text[0]` and broadcast the same payload over WS.
//
// Probe ids follow the shape `__studio_enhanced_<sourceNodeId>` so the
// matcher in the gallery service can grep one regex (`^__studio_enhanced_`)
// AND recover the source node id from the suffix without a side table.
// The double-underscore prefix avoids collisions with the flat compound
// ids the flattener emits (e.g. `424:444`).

import type { ApiPrompt } from './types.js';

const PROBE_PREFIX = '__studio_enhanced_';
const TEXT_GENERATE_PREFIX = /^TextGenerate/;
const SWITCH_TYPES = new Set(['ComfySwitchNode']);
const BOOLEAN_LITERAL_TYPES = new Set(['PrimitiveBoolean']);

/** Compute the probe id for a given enhancer source node id. */
export function probeIdFor(sourceNodeId: string): string {
  return `${PROBE_PREFIX}${sourceNodeId}`;
}

/** Inverse of {@link probeIdFor}: extract the source node id from a probe
 *  key, or null when `key` isn't a Studio probe. */
export function sourceIdFromProbeKey(key: string): string | null {
  if (!key.startsWith(PROBE_PREFIX)) return null;
  return key.slice(PROBE_PREFIX.length);
}

/** Pull the source node id out of a `[<id>, <slot>]` wire input. Returns
 *  null when `value` isn't a wire. */
function wireSourceId(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const head = value[0];
  if (typeof head === 'string') return head;
  if (typeof head === 'number' && Number.isFinite(head)) return String(head);
  return null;
}

/** Resolve a boolean input to its static value. Handles literal `true`/`false`
 *  in the inputs map AND a wire to a PrimitiveBoolean node. Returns null when
 *  the value can't be evaluated statically (wired to a non-Primitive, missing
 *  node, etc.). */
function resolveStaticBoolean(prompt: ApiPrompt, value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const src = wireSourceId(value);
  if (!src) return null;
  const node = prompt[src];
  if (!node || !node.class_type) return null;
  if (!BOOLEAN_LITERAL_TYPES.has(node.class_type)) return null;
  const v = node.inputs?.value;
  return typeof v === 'boolean' ? v : null;
}

/**
 * Decide whether a `TextGenerate*` source is reachable by any downstream
 * consumer at execution time. Walks every node in the api-prompt; for each
 * input wire pointing at `sourceId`, classify the consumer:
 *
 *   - Non-switch node (or a switch whose gating boolean isn't statically
 *     known) → counts as a "real" consumer → return true.
 *   - ComfySwitchNode where the source feeds `on_true` and the switch is
 *     statically `false` (or vice-versa) → gated out, ignored.
 *
 * Returns false when EVERY consumer is statically gated away. That means
 * the user opted out of enhancement (toggle off) and there's no point in
 * spending GPU cycles to capture the LLM output — skip the probe.
 *
 * Conservative on unknowns: a wired-but-non-Primitive `switch` input is
 * treated as "could be either way", so the probe still fires. We only
 * skip when we're certain the path is dead.
 */
function hasReachableConsumer(prompt: ApiPrompt, sourceId: string): boolean {
  let hasRealConsumer = false;
  let hasAnyConsumer = false;
  for (const [consumerId, consumer] of Object.entries(prompt)) {
    if (consumerId === sourceId) continue;
    if (consumerId.startsWith(PROBE_PREFIX)) continue;
    const inputs: Record<string, unknown> = (consumer?.inputs ?? {}) as Record<string, unknown>;
    for (const [inputName, val] of Object.entries(inputs)) {
      if (wireSourceId(val) !== sourceId) continue;
      hasAnyConsumer = true;
      const cls = consumer.class_type ?? '';
      // Switch routing: when this source feeds an on_true/on_false slot and
      // the switch's boolean is statically known to discard that slot, the
      // path is dead. Otherwise the consumer is "real".
      if (SWITCH_TYPES.has(cls) && (inputName === 'on_true' || inputName === 'on_false')) {
        const switchBool = resolveStaticBoolean(prompt, inputs.switch);
        if (switchBool === null) {
          // Unknown gating → assume the source is reachable so we don't
          // silently strip a probe the user expected to fire.
          hasRealConsumer = true;
          continue;
        }
        const wantOnTrue = inputName === 'on_true';
        if (switchBool === wantOnTrue) hasRealConsumer = true;
        // else: this slot is statically discarded — skip.
      } else {
        hasRealConsumer = true;
      }
    }
  }
  // A node with zero consumers at all (e.g. user dropped a TextGenerate
  // without wiring it) shouldn't add execution cost either.
  return hasAnyConsumer && hasRealConsumer;
}

/**
 * Append a `PreviewAny` probe for every TextGenerate-class node already
 * present in the api-prompt. Probes are idempotent — if one is already
 * present (caller invoked twice, or the user authored their own) we leave
 * it alone. Mutates `prompt` in place; returns the list of (source, probe)
 * pairs that were added so callers can log / track them.
 */
export function injectEnhancerProbes(
  prompt: ApiPrompt,
): Array<{ sourceNodeId: string; probeId: string }> {
  const added: Array<{ sourceNodeId: string; probeId: string }> = [];
  const sourceIds: string[] = [];
  for (const [nodeId, node] of Object.entries(prompt)) {
    const cls = node?.class_type;
    if (typeof cls !== 'string') continue;
    if (!TEXT_GENERATE_PREFIX.test(cls)) continue;
    if (nodeId.startsWith(PROBE_PREFIX)) continue; // never probe a probe
    sourceIds.push(nodeId);
  }
  for (const sourceNodeId of sourceIds) {
    const probeId = probeIdFor(sourceNodeId);
    if (probeId in prompt) continue; // already probed
    // Skip probing when the source is gated out by a statically-known switch
    // boolean — without this guard the probe would force the LLM to run even
    // for "enhance off" submissions, wasting GPU and surfacing a misleading
    // "Enhanced prompt" row on a generation the user opted out of.
    if (!hasReachableConsumer(prompt, sourceNodeId)) continue;
    prompt[probeId] = {
      class_type: 'PreviewAny',
      inputs: { source: [sourceNodeId, 0] },
    };
    added.push({ sourceNodeId, probeId });
  }
  return added;
}
