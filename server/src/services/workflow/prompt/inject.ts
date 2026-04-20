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
    if (val == null) continue;
    if (binding.nodeId == null) continue;
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

// Collect the multiline STRING input names for a class_type.
function multilineStringTargets(
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
    if (!Array.isArray(spec) || spec[0] !== 'STRING') continue;
    const opts = spec[1] as { multiline?: boolean } | undefined;
    if (opts?.multiline === true) targets.push(name);
  }
  return targets;
}

/**
 * Inject the user's prompt into EXACTLY ONE node — the first
 * non-negative-titled node with multiline STRING widgets. Every such
 * widget on that one node receives the prompt text, then we stop.
 *
 * Covers CLIPTextEncode (single `text`), CLIPTextEncodeFlux
 * (`clip_l` + `t5xxl`), CLIPTextEncodeSDXL (`text_g` + `text_l`),
 * TextEncodeAceStepAudio, etc.
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
    const targets = multilineStringTargets(objectInfo, node.type);
    if (targets.length === 0) continue;
    for (const name of targets) nodeData.inputs[name] = promptText;
    break;
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
 * Pre-flatten: mutate every PrimitiveString* holder so its widgets_values[0]
 * carries the user's prompt. These nodes never reach the API prompt
 * themselves — resolveInput inlines their value into every downstream
 * consumer — so seeding them carries the prompt through automatically.
 */
export function seedPrimitiveStringHolders(
  nodes: Map<string, FlatNode>,
  userPromptText: unknown,
): void {
  if (typeof userPromptText !== 'string' || userPromptText.length === 0) return;
  for (const node of nodes.values()) {
    if (node.type === 'PrimitiveString' || node.type === 'PrimitiveStringMultiline') {
      node.widgets_values = [userPromptText];
    }
  }
}
