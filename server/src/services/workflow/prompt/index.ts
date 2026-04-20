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
  applyFormInputs,
  injectUserPrompt,
  randomizeSeeds,
  seedPrimitiveStringHolders,
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

  // Mutate PrimitiveString* holders BEFORE the resolve context is built so
  // their values carry into every downstream consumer via resolveInput.
  seedPrimitiveStringHolders(nodes, userInputs.prompt);

  const ctx = buildResolveCtx(nodes, links, objectInfo);

  // Phase 2 — emit nodes.
  const prompt = emitNodesFromWorkflow(nodes, objectInfo, ctx);

  // Phase 3 — form input bindings.
  applyFormInputs(prompt, formInputs, userInputs);

  // Phase 4 — inject user prompt into one node.
  const promptText = userInputs.prompt;
  if (typeof promptText === 'string' && promptText !== '') {
    injectUserPrompt(prompt, nodes, objectInfo, promptText);
  }

  // Phase 5 — randomise seeds.
  randomizeSeeds(prompt);

  return prompt;
}
