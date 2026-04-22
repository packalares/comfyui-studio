// workflowToApiPrompt — the five-phase UI-format -> API prompt pipeline.
//
//   1. Flatten the workflow (subgraph wrappers inlined, links rewired).
//   2. Emit one API prompt entry per real node (UI-only types skipped).
//   3. Apply formInput uploads (image/audio/video) onto declared nodes.
//   4. Inject the user prompt into exactly ONE node (first non-negative
//      node with multiline STRING widgets; every such widget on it).
//   5. Randomise KSampler / RandomNoise seeds.
//
// Phase 4 writes to ONE node only. Covers CLIPTextEncode (single `text`),
// CLIPTextEncodeFlux (`clip_l` + `t5xxl`), CLIPTextEncodeSDXL
// (`text_g` + `text_l`), TextEncodeAceStepAudio, etc. Single-line STRING
// inputs (filename_prefix, model names) are skipped by the
// `multiline: true` check.

import type { FormInputBinding } from '../../../contracts/workflow.contract.js';
import { flattenWorkflow, type FlatLink, type FlatNode } from '../flatten/index.js';
import { getObjectInfo } from '../objectInfo.js';
import { buildSetterMap, type ResolveCtx } from '../resolve.js';
import {
  applyBoundFormInputs,
  applyFormInputs,
  applyPrimitiveOverrides,
  injectUserPrompt,
  randomizeSeeds,
} from './inject.js';
import { emitNodesFromWorkflow } from './nodeEmit.js';
import type { ApiPrompt } from './types.js';

export type { ApiPrompt, PromptEntry } from './types.js';

// Build the ResolveCtx once (linkMap index + SetNode pre-computation).
function buildResolveCtx(
  nodes: Map<string, FlatNode>,
  links: FlatLink[],
  objectInfo: Record<string, Record<string, unknown>>,
): ResolveCtx {
  const linkMap = new Map<number, FlatLink>();
  for (const l of links) linkMap.set(l.id, l);
  const base = { linkMap, nodes, objectInfo };
  const setterMap = buildSetterMap(base);
  return { ...base, setterMap };
}

/**
 * Convert a UI-format workflow to ComfyUI API prompt format. Handles
 * arbitrarily nested subgraphs, Reroute pass-through, Get/Set variables
 * and bypassed nodes. See the module-level comment for the 5 phases.
 */
export async function workflowToApiPrompt(
  wf: Record<string, unknown>,
  userInputs: Record<string, unknown>,
  formInputs: FormInputBinding[] = [],
): Promise<ApiPrompt> {
  const objectInfo = await getObjectInfo();

  // Phase 1 — flatten.
  const { nodes, links } = flattenWorkflow(wf);

  const ctx = buildResolveCtx(nodes, links, objectInfo);

  // Phase 2 — emit nodes.
  const prompt = emitNodesFromWorkflow(nodes, objectInfo, ctx);

  // Phase 3 — form input bindings (image/audio/video uploads) + Primitive
  // overrides (Prompt / Width / Height / ... form fields → Primitive.value).
  // Primitive overrides run first so they populate the canonical fields;
  // applyFormInputs writes upload filenames onto LoadImage nodes.
  applyPrimitiveOverrides(prompt, userInputs);
  applyFormInputs(prompt, formInputs, userInputs);

  // Phase 3b — bound form inputs: explicit (bindNodeId, bindWidgetName)
  // writes for each prompt-surface field emitted by the workflow-reading
  // path in `generateFormInputs`. Runs before the legacy fan-out so
  // multi-field encoders (TextEncodeAceStepAudio1.5's tags + lyrics) get
  // distinct per-widget writes instead of one prompt fanned across both.
  const bindings: Array<{ bindNodeId: string; bindWidgetName: string; value: unknown }> = [];
  for (const fi of formInputs) {
    if (!fi.bindNodeId || !fi.bindWidgetName) continue;
    if (!(fi.id in userInputs)) continue;
    bindings.push({
      bindNodeId: fi.bindNodeId,
      bindWidgetName: fi.bindWidgetName,
      value: userInputs[fi.id],
    });
  }
  const boundCovered = applyBoundFormInputs(prompt, nodes, bindings);

  // Phase 4 — legacy fan-out injection of the generic `prompt` input. Only
  // fires when the bound path did NOT handle any prompt-surface widget —
  // i.e. tag-only templates without a workflow-derived binding. Preserves
  // the wire-guard (skip inputs that are already `[nodeId, slot]` arrays).
  const promptText = userInputs.prompt;
  if (boundCovered.size === 0 && typeof promptText === 'string' && promptText !== '') {
    injectUserPrompt(prompt, nodes, objectInfo, promptText);
  }

  // Phase 5 — randomise seeds.
  randomizeSeeds(prompt);

  return prompt;
}
