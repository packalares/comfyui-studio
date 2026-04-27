// Gallery metadata extractor — workflow-agnostic.
//
// Given the emitted API prompt, the source workflow JSON (to read
// Primitive* node titles from subgraph definitions), and optionally
// ComfyUI's history `status.messages`, produce a rich ExtractedMetadata
// that captures dimensions, sampler params, prompt text, model files,
// and execution duration across classic SD, modern subgraph video
// (LTX2/Wan/Hunyuan), audio, and future architectures.
//
// Precedence (highest → lowest):
//   1. Primitive* node titles in the workflow JSON — authored role names.
//   2. Widget-name scan over every apiPrompt node's inputs.
//   3. Wire-chasing through Primitive/Reroute/trivial-math wrappers.
// Extraction never throws; every unresolved field stays null.

import { extractFromTitles, extractFromApiPromptTitles } from './gallery.extract.titles.js';
import { scanWidgets } from './gallery.extract.scan.js';
import { resolveLiteral, followWireToSource, wireTargetId } from './gallery.extract.wires.js';
import { UI_ONLY_TYPES } from './workflow/constants.js';
import type {
  ApiPrompt, ApiPromptNode, ExtractedMetadata,
} from './gallery.extract.types.js';

export type { ApiPrompt, ApiPromptNode, ExtractedMetadata };

const KSAMPLER_TYPES = new Set(['KSampler', 'KSamplerAdvanced']);
const TEXT_ENCODE_RX = /TextEncode/i;
// Wire-chase depth cap matches gallery.extract.wires.ts MAX_DEPTH. Stock
// LTX 2.3 chains are ~4 hops (KSampler → CLIPTextEncode → TextGenerateLTX2Prompt
// → PrimitiveStringMultiline); user reroutes can add more.
const PROMPT_CHASE_MAX_DEPTH = 10;
// Inputs we follow when chasing a prompt wire backward through encoders /
// generators. Listed in priority order: `prompt` is the convention for
// TextGenerate* and similar wrappers; `text` is the CLIP convention; `value`
// is the Primitive* convention.
const PROMPT_WIRE_INPUT_NAMES = ['prompt', 'text', 'value'];

/**
 * Domain-specific encoder nodes that don't use CLIP's `text` convention.
 * For each class pattern, try the listed fields in order — the first one
 * holding a non-empty literal becomes the promptText.
 *
 * - `TextEncodeAceStepAudio*` (ACE-Step audio): `tags` (genre/mood) beats
 *   `lyrics` for Pexels-style stock search because it's concrete keywords.
 */
const DOMAIN_ENCODERS: Array<{ classPattern: RegExp; fields: string[] }> = [
  { classPattern: /^TextEncodeAceStepAudio/, fields: ['tags', 'lyrics'] },
];

function emptyMeta(): ExtractedMetadata {
  return {
    promptText: null, negativeText: null, seed: null, model: null,
    sampler: null, scheduler: null, steps: null, cfg: null, denoise: null,
    width: null, height: null, length: null, fps: null, batchSize: null,
    durationMs: null, models: [],
  };
}

/**
 * Positive prompt. Precedence:
 *   1. KSampler `positive` wire → CLIPTextEncode literal (classic SD).
 *   2. Longest-literal CLIPTextEncode (legacy heuristic — covers workflows
 *      where the sampler wire doesn't resolve to a CLIPTextEncode OR the
 *      KSampler is absent but multiple CLIPTextEncodes exist).
 *   3. Upstream wire-chase from any TextEncode-like node whose `text` /
 *      `prompt` input is a wire — for modern LTX2/Gemma pipelines where
 *      the literal lives in a PrimitiveStringMultiline upstream of a
 *      TextGenerate* wrapper.
 */
/**
 * Step 0: domain-specific encoder shapes (ACE-Step audio, etc.) whose
 * inputs don't match the CLIP `text` convention. Returns null when no
 * domain encoder is present so we fall through to the classic resolvers.
 */
function resolveDomainSpecificPrompt(prompt: ApiPrompt): string | null {
  for (const node of Object.values(prompt)) {
    const className = node?.class_type;
    if (!className) continue;
    const match = DOMAIN_ENCODERS.find(e => e.classPattern.test(className));
    if (!match) continue;
    for (const field of match.fields) {
      const v = node.inputs?.[field];
      if (typeof v === 'string' && v.trim() !== '') return v;
      if (Array.isArray(v)) {
        const lit = resolveLiteral(prompt, v);
        if (typeof lit === 'string' && lit.trim() !== '') return lit;
      }
    }
  }
  return null;
}

/**
 * Chase a prompt-bearing wire backward through Primitive holders, UI-only
 * pass-through nodes, and any TextGenerate / encoder node that has a
 * `prompt` / `text` / `value` input we can follow. Returns the first
 * non-empty string literal we land on, or null when the chain doesn't
 * terminate in one (complex math, missing wires, depth cap, cycles).
 *
 * This is the missing link for modern LTX 2.3 / Wan / Hunyuan workflows
 * where the user's typed prompt sits in a PrimitiveStringMultiline that
 * feeds a TextGenerateLTX2Prompt that feeds the positive CLIPTextEncode.
 * Without recursive chasing we'd stop at the encoder's wired `text` input
 * and miss the user prompt entirely.
 */
function chasePromptWire(
  prompt: ApiPrompt,
  value: unknown,
  depth = 0,
): string | null {
  if (depth > PROMPT_CHASE_MAX_DEPTH) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (!Array.isArray(value)) return null;
  const id = wireTargetId(value);
  if (!id) return null;
  const node = prompt[id];
  if (!node?.class_type) return null;
  // Try the standard literal-resolver first — handles Primitive* and
  // ComfyMathExpression cases consistently with the rest of the extractor.
  const lit = resolveLiteral(prompt, value, depth);
  if (typeof lit === 'string' && lit.trim() !== '') return lit;
  if (UI_ONLY_TYPES.has(node.class_type)) {
    const first = Object.values(node.inputs ?? {})[0];
    return chasePromptWire(prompt, first, depth + 1);
  }
  // Generator / encoder node: keep chasing through whichever named input
  // carries the prompt text upstream.
  const inputs = node.inputs ?? {};
  for (const name of PROMPT_WIRE_INPUT_NAMES) {
    if (!(name in inputs)) continue;
    const next = (inputs as Record<string, unknown>)[name];
    const chased = chasePromptWire(prompt, next, depth + 1);
    if (chased !== null) return chased;
  }
  return null;
}

function resolvePromptText(prompt: ApiPrompt): string | null {
  // Step 0: domain-specific encoders (ACE-Step audio `tags`, etc.).
  const domain = resolveDomainSpecificPrompt(prompt);
  if (domain !== null) return domain;

  // Step 1: KSampler-like sampler → positive wire → CLIPTextEncode.text →
  // recursive chase to the literal source. Handles classic SD (literal text
  // on the encoder), modern LTX/Wan/Hunyuan (wired through TextGenerate*
  // back to a Primitive), and reroute chains transparently.
  for (const node of Object.values(prompt)) {
    if (!node?.class_type || !KSAMPLER_TYPES.has(node.class_type)) continue;
    const posId = wireTargetId(node.inputs?.positive);
    if (!posId) continue;
    const target = prompt[posId];
    if (target?.class_type !== 'CLIPTextEncode') continue;
    const t = target.inputs?.text;
    if (typeof t === 'string' && t.trim() !== '') return t;
    if (Array.isArray(t)) {
      const chased = chasePromptWire(prompt, t);
      if (chased !== null) return chased;
    }
  }

  // Step 2: longest literal CLIPTextEncode, EXCLUDING any encoder whose
  // output flows into a sampler's `negative` slot. Without that exclusion
  // (the legacy behaviour) workflows that wire the positive and leave a
  // long negative-prompt default like "pc game, console game, video game,
  // cartoon, childish, ugly" would mistakenly label the negative as the
  // user prompt.
  const longest = longestCLIPTextEncode(prompt);
  if (longest !== null) return longest;

  // Step 3: wire-chase from any TextEncode-like node.
  for (const node of Object.values(prompt)) {
    if (!node?.class_type) continue;
    const isEncoder = TEXT_ENCODE_RX.test(node.class_type)
      || (node.inputs && ('text' in node.inputs || 'prompt' in node.inputs));
    if (!isEncoder) continue;
    const inputs = node.inputs ?? {};
    const raw = inputs.text ?? inputs.prompt;
    if (!Array.isArray(raw)) continue;
    const lit = resolveLiteral(prompt, raw);
    if (typeof lit === 'string' && lit.trim() !== '') return lit;
    const src = followWireToSource(prompt, raw);
    if (!src) continue;
    for (const v of Object.values(src.node.inputs ?? {})) {
      if (!Array.isArray(v)) continue;
      const inner = resolveLiteral(prompt, v);
      if (typeof inner === 'string' && inner.trim() !== '') return inner;
    }
  }
  return null;
}

/**
 * Collect the set of encoder node IDs whose output flows (directly or via
 * pass-through nodes) into ANY sampler-like node's `negative` slot. We
 * walk every node looking for `inputs.negative` / `inputs.negative_*` wires
 * and follow them backward through UI-only / Primitive holders to land on
 * the encoder. Same idea as resolveNegative's wire chase, but materialised
 * as a set so longestCLIPTextEncode can exclude them.
 */
function collectNegativeEncoderIds(prompt: ApiPrompt): Set<string> {
  const out = new Set<string>();
  const visit = (id: string | null, depth: number): void => {
    if (!id || depth > PROMPT_CHASE_MAX_DEPTH) return;
    const node = prompt[id];
    if (!node?.class_type) return;
    if (node.class_type === 'CLIPTextEncode') {
      out.add(id);
      // Don't return — text input may itself be wired through a Primitive,
      // but we only mark the encoder; further chasing isn't useful here.
      return;
    }
    if (UI_ONLY_TYPES.has(node.class_type)) {
      const first = Object.values(node.inputs ?? {})[0];
      visit(wireTargetId(first), depth + 1);
    }
  };
  for (const node of Object.values(prompt)) {
    if (!node?.inputs) continue;
    for (const [key, val] of Object.entries(node.inputs)) {
      if (key !== 'negative' && !key.startsWith('negative')) continue;
      visit(wireTargetId(val), 0);
    }
  }
  return out;
}

/**
 * Classic heuristic fallback — longest CLIPTextEncode string wins, but
 * skip encoders that we've identified as the negative-conditioning source
 * (their long defaults would otherwise mislabel the prompt).
 */
function longestCLIPTextEncode(prompt: ApiPrompt): string | null {
  const negatives = collectNegativeEncoderIds(prompt);
  let best: string | null = null;
  for (const [id, node] of Object.entries(prompt)) {
    if (node?.class_type !== 'CLIPTextEncode') continue;
    if (negatives.has(id)) continue;
    const t = node.inputs?.text;
    if (typeof t !== 'string') continue;
    if (best === null || t.length > best.length) best = t;
  }
  return best;
}

/**
 * Negative prompt resolution. When a KSampler exists we follow its
 * `negative` wire to a CLIPTextEncode; unresolved wires default to empty
 * string (matches the Wave-F back-compat contract where "no negative"
 * vs "negative resolution failed" are distinguishable from null).
 *
 * When no KSampler is present, pick any CLIPTextEncode literal that
 * differs from the positive — the second encoder in typical two-encoder
 * workflows.
 */
function resolveNegative(prompt: ApiPrompt, positive: string | null): string | null {
  let sawKSampler = false;
  for (const node of Object.values(prompt)) {
    if (!node?.class_type || !KSAMPLER_TYPES.has(node.class_type)) continue;
    sawKSampler = true;
    const negId = wireTargetId(node.inputs?.negative);
    if (!negId) continue;
    const n = prompt[negId];
    if (!n || n.class_type !== 'CLIPTextEncode') continue;
    const t = n.inputs?.text;
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) {
      const lit = resolveLiteral(prompt, t);
      if (typeof lit === 'string') return lit;
    }
  }
  if (sawKSampler) return '';
  for (const node of Object.values(prompt)) {
    if (node?.class_type !== 'CLIPTextEncode') continue;
    const t = node.inputs?.text;
    if (typeof t !== 'string' || t === positive) continue;
    return t;
  }
  return null;
}

function durationFromStatus(statusMessages: unknown): number | null {
  if (!Array.isArray(statusMessages)) return null;
  let start: number | null = null;
  let end: number | null = null;
  for (const msg of statusMessages) {
    if (!Array.isArray(msg) || msg.length < 2) continue;
    const [kind, payload] = msg;
    if (!payload || typeof payload !== 'object') continue;
    const ts = (payload as { timestamp?: unknown }).timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    if (kind === 'execution_start') start = ts;
    else if (kind === 'execution_success') end = ts;
  }
  if (start === null || end === null) return null;
  return Math.max(0, Math.round(end - start));
}

/**
 * Public entry point. Back-compat: legacy callers that pass only the
 * apiPrompt still get the classic fields populated; the extra
 * workflowJson / statusMessages arguments unlock title and duration
 * extraction when provided.
 */
export function extractMetadata(
  apiPrompt: ApiPrompt | null | undefined,
  workflowJson?: unknown,
  statusMessages?: unknown,
): ExtractedMetadata {
  const out = emptyMeta();
  if (!apiPrompt || typeof apiPrompt !== 'object') {
    out.durationMs = durationFromStatus(statusMessages);
    return out;
  }

  const titleFields = extractFromTitles(workflowJson);
  // Importer paths (gallery.service.ts::syncFromComfyUI etc.) only have
  // the API prompt — ComfyUI's /history doesn't return the workflow JSON.
  // Walk the API-prompt-format Primitives by `_meta.title` so the same
  // role-name extraction works regardless of which payload reached us.
  const apiTitleFields = extractFromApiPromptTitles(apiPrompt);
  const scanFields = scanWidgets(apiPrompt);

  // Precedence: workflow titles > apiPrompt titles > widget-name scan.
  const pick = <K extends keyof ExtractedMetadata>(key: K): ExtractedMetadata[K] => {
    const t = (titleFields as Record<string, unknown>)[key];
    const a = (apiTitleFields as Record<string, unknown>)[key];
    const s = (scanFields as Record<string, unknown>)[key];
    return (t ?? a ?? s ?? null) as ExtractedMetadata[K];
  };

  out.width     = pick('width');
  out.height    = pick('height');
  out.length    = pick('length');
  out.fps       = pick('fps');
  out.steps     = pick('steps');
  out.cfg       = pick('cfg');
  out.denoise   = pick('denoise');
  out.batchSize = pick('batchSize');
  out.seed      = pick('seed');
  out.sampler   = pick('sampler');
  out.scheduler = pick('scheduler');

  const titlePrompt = titleFields.promptText ?? apiTitleFields.promptText ?? null;
  const titleNegative = titleFields.negativeText ?? apiTitleFields.negativeText ?? null;
  // `resolvePromptText` already tries `longestCLIPTextEncode` as its Step 2,
  // so the tail fallback (previously: `?? longestCLIPTextEncode(apiPrompt)`)
  // was guaranteed to return null whenever wiredPrompt was null — redundant.
  const wiredPrompt = resolvePromptText(apiPrompt);
  out.promptText = titlePrompt ?? wiredPrompt;
  const wiredNegative = resolveNegative(apiPrompt, out.promptText);
  out.negativeText = titleNegative ?? wiredNegative;

  const models = scanFields.models ?? [];
  out.models = models;
  // `model` is the back-compat single-field alias: first discovered weight
  // file, preferring checkpoints when we can identify one. We just use the
  // scan order, which walks Object.values(prompt) — stable within a run.
  out.model = models[0] ?? null;

  out.durationMs = durationFromStatus(statusMessages);
  return out;
}

/**
 * Walk the prompt in-place and replace `seed`/`noise_seed` on every
 * KSampler variant with a new random int. Used by the regenerate endpoint
 * when the caller opts into seed randomisation. Mutates the input.
 *
 * NOT the same as `randomizeSeeds` in `workflow/prompt/inject.ts` — this
 * one is aggressive (seed+noise_seed on every KSampler node) and uses
 * `0xffffffff`; the inject one is class-specific (`seed` on KSampler
 * variants, `noise_seed` on RandomNoise) and uses `2147483647`. Keeping
 * them intentionally different matches the different call-site needs
 * (stored-workflow replay vs. fresh-generation dispatch).
 */
export function randomizeStoredSeeds(prompt: ApiPrompt): void {
  for (const node of Object.values(prompt)) {
    if (!node?.class_type || !KSAMPLER_TYPES.has(node.class_type)) continue;
    if (!node.inputs) continue;
    const next = Math.floor(Math.random() * 0xffffffff);
    if ('seed' in node.inputs) node.inputs.seed = next;
    if ('noise_seed' in node.inputs) node.inputs.noise_seed = next;
  }
}

