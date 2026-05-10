// Gallery metadata extractor — workflow-agnostic pipeline.
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

import { logger } from '../../lib/logger.js';
import { UI_ONLY_TYPES } from '../workflow/constants.js';
import { collectAllNodes, type WorkflowWithSubgraphs } from '../workflow/walkNodes.js';

// ─── Shared types ────────────────────────────────────────────────────────────

export interface ApiPromptNode {
  class_type?: string;
  inputs?: Record<string, unknown>;
}

export type ApiPrompt = Record<string, ApiPromptNode>;

export interface ExtractedMetadata {
  promptText: string | null;
  negativeText: string | null;
  seed: number | null;
  model: string | null;
  sampler: string | null;
  scheduler: string | null;
  steps: number | null;
  cfg: number | null;
  denoise: number | null;
  width: number | null;
  height: number | null;
  length: number | null;
  fps: number | null;
  batchSize: number | null;
  durationMs: number | null;
  models: string[];
}

// Subsets produced by title + scan passes; orchestrator merges with precedence.
type TitleFields = Omit<ExtractedMetadata, 'durationMs' | 'model' | 'models'>;
type ScanFields  = Omit<ExtractedMetadata, 'durationMs' | 'model' | 'promptText' | 'negativeText'>;

// ─── Wire resolution ─────────────────────────────────────────────────────────

// Depth cap: stock LTX-2.3 chains are ~4 hops; 10 is well above any realistic
// authored chain while preventing pathological loops from stack-overflowing.
const MAX_DEPTH = 10;

const PRIMITIVE_TYPES_SET = new Set<string>([
  'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean',
  'PrimitiveString', 'PrimitiveStringMultiline',
]);

/** Unwrap a `[nodeId, slot]` wire to a string nodeId, or null if not a wire. */
export function wireTargetId(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const head = v[0];
  if (typeof head === 'string') return head;
  if (typeof head === 'number' && Number.isFinite(head)) return String(head);
  return null;
}

function primitiveValue(node: ApiPromptNode): unknown {
  // In API prompts, Primitive* nodes expose their literal under `inputs.value`
  // (emitted from widgets_values[0]). Some legacy forks may use other keys —
  // fall back to the first input value defensively.
  const inputs = node.inputs ?? {};
  if ('value' in inputs) return inputs.value;
  const entries = Object.entries(inputs);
  return entries.length > 0 ? entries[0]![1] : undefined;
}

/**
 * Parse a trivial ComfyMathExpression of the forms `a`, `a/N`, `a*N`,
 * `a+N`, `a-N` where N is a numeric constant. Returns null for anything
 * more complex (involving `b`/`c`, parentheses, multiple ops, functions).
 */
function parseSimpleMath(expr: string): { op: '+' | '-' | '*' | '/' | '='; rhs: number } | null {
  const trimmed = expr.trim();
  if (trimmed === 'a') return { op: '=', rhs: 0 };
  const m = /^a\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!m) return null;
  const op = m[1] as '+' | '-' | '*' | '/';
  const rhs = Number(m[2]);
  if (!Number.isFinite(rhs)) return null;
  return { op, rhs };
}

function applyMath(a: number, op: '+' | '-' | '*' | '/' | '=', rhs: number): number | null {
  switch (op) {
    case '=': return a;
    case '+': return a + rhs;
    case '-': return a - rhs;
    case '*': return a * rhs;
    case '/': return rhs === 0 ? null : a / rhs;
    default: return null;
  }
}

/**
 * Resolve a value that may be either a literal or a wire to an upstream
 * node's output. Walks through Primitive holders, UI-only pass-through
 * nodes, and trivially-evaluable math expressions. Returns the literal or
 * null when the chain can't be reduced (complex math, cycles, unknown types).
 */
export function resolveLiteral(
  prompt: ApiPrompt,
  value: unknown,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) {
    logger.debug('wire chase: resolveLiteral hit depth cap', { depth, id: wireTargetId(value) });
    return null;
  }
  if (!Array.isArray(value)) return value;
  const id = wireTargetId(value);
  if (!id) return null;
  const node = prompt[id];
  if (!node || !node.class_type) return null;

  if (PRIMITIVE_TYPES_SET.has(node.class_type)) {
    return primitiveValue(node);
  }
  if (UI_ONLY_TYPES.has(node.class_type)) {
    const firstInput = Object.values(node.inputs ?? {})[0];
    return resolveLiteral(prompt, firstInput, depth + 1);
  }
  if (node.class_type === 'ComfyMathExpression') {
    const expr = node.inputs?.expression;
    if (typeof expr !== 'string') return null;
    const parsed = parseSimpleMath(expr);
    if (!parsed) return null;
    const aWire = node.inputs?.['values.a'];
    const aVal = resolveLiteral(prompt, aWire, depth + 1);
    if (typeof aVal !== 'number' || !Number.isFinite(aVal)) return null;
    return applyMath(aVal, parsed.op, parsed.rhs);
  }
  return null;
}

/**
 * Walk wires until the first non-Primitive / non-UI node on the chain.
 * Used by prompt-text resolution when we want the emitting node (e.g. a
 * TextGenerate* node) rather than the raw literal.
 */
export function followWireToSource(
  prompt: ApiPrompt,
  value: unknown,
  depth = 0,
): { nodeId: string; node: ApiPromptNode } | null {
  if (depth > MAX_DEPTH) {
    logger.debug('wire chase: followWireToSource hit depth cap', { depth, id: wireTargetId(value) });
    return null;
  }
  const id = wireTargetId(value);
  if (!id) return null;
  const node = prompt[id];
  if (!node || !node.class_type) return null;
  if (UI_ONLY_TYPES.has(node.class_type)) {
    const first = Object.values(node.inputs ?? {})[0];
    return followWireToSource(prompt, first, depth + 1);
  }
  return { nodeId: id, node };
}

// ─── Title-based extraction (workflow JSON + API-prompt paths) ────────────────

interface WorkflowNode {
  type?: string;
  title?: string;
  widgets_values?: unknown[];
}

interface TitleRule {
  pattern: RegExp;
  field: keyof TitleFields;
  kind: 'number' | 'string';
}

const TITLE_RULES: TitleRule[] = [
  { pattern: /^width$/i,                field: 'width',        kind: 'number' },
  { pattern: /^height$/i,               field: 'height',       kind: 'number' },
  { pattern: /^(length|frames?)$/i,     field: 'length',       kind: 'number' },
  { pattern: /^(fps|frame ?rate)$/i,    field: 'fps',          kind: 'number' },
  { pattern: /^steps?$/i,               field: 'steps',        kind: 'number' },
  { pattern: /^(cfg|guidance)$/i,       field: 'cfg',          kind: 'number' },
  { pattern: /^denoise$/i,              field: 'denoise',      kind: 'number' },
  { pattern: /^batch ?size$/i,          field: 'batchSize',    kind: 'number' },
  { pattern: /^(seed|noise ?seed)$/i,   field: 'seed',         kind: 'number' },
  { pattern: /^sampler$/i,              field: 'sampler',      kind: 'string' },
  { pattern: /^scheduler$/i,            field: 'scheduler',    kind: 'string' },
  { pattern: /^prompt$/i,               field: 'promptText',   kind: 'string' },
  { pattern: /^negative ?prompt$/i,     field: 'negativeText', kind: 'string' },
];

function titleToNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function titleToString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function applyTitleRule(out: Partial<TitleFields>, title: string, literal: unknown): void {
  for (const rule of TITLE_RULES) {
    if (!rule.pattern.test(title)) continue;
    if (out[rule.field] != null) return;
    if (rule.kind === 'number') {
      const n = titleToNumber(literal);
      if (n !== null) (out[rule.field] as unknown) = n;
    } else {
      const s = titleToString(literal);
      if (s !== null && s !== '') (out[rule.field] as unknown) = s;
    }
    return;
  }
}

/**
 * Walk every Primitive* node across the workflow + its subgraph defs,
 * match node titles against the known role patterns, and record the
 * literal from widgets_values[0]. Returns a partial TitleFields record.
 */
function extractFromTitles(workflowJson: unknown): Partial<TitleFields> {
  if (!workflowJson || typeof workflowJson !== 'object') return {};
  const out: Partial<TitleFields> = {};
  for (const node of collectAllNodes(workflowJson as WorkflowWithSubgraphs<WorkflowNode>)) {
    if (!node.type || !PRIMITIVE_TYPES_SET.has(node.type)) continue;
    const title = typeof node.title === 'string' ? node.title.trim() : '';
    if (!title) continue;
    const literal = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
    if (literal === undefined) continue;
    applyTitleRule(out, title, literal);
  }
  return out;
}

/**
 * Mirror of extractFromTitles operating on the API-prompt format. Used by
 * the gallery importer's syncFromComfyUI path where workflowJson is unavailable.
 * API-prompt nodes carry their authored title in `_meta.title` and their
 * literal in `inputs.value` (Primitive*).
 */
function extractFromApiPromptTitles(prompt: ApiPrompt | null | undefined): Partial<TitleFields> {
  if (!prompt || typeof prompt !== 'object') return {};
  const out: Partial<TitleFields> = {};
  for (const node of Object.values(prompt)) {
    const classType = node?.class_type;
    if (!classType || !PRIMITIVE_TYPES_SET.has(classType)) continue;
    const meta = (node as unknown as { _meta?: { title?: unknown } })._meta;
    const titleRaw = meta?.title;
    const title = typeof titleRaw === 'string' ? titleRaw.trim() : '';
    if (!title) continue;
    const literal = node.inputs?.value;
    if (literal === undefined) continue;
    applyTitleRule(out, title, literal);
  }
  return out;
}

// ─── Widget-name scan ─────────────────────────────────────────────────────────

const MODEL_EXT_RX = /\.(safetensors|pth|ckpt|pt|bin|gguf|onnx)$/i;

interface NumberRule { field: keyof ScanFields; names: string[] }

// Alias order defines precedence: the first name in the list that resolves to
// a number wins for that node. (Prior versions had an opt-in `preferFirst`
// flag but defaulted to last-wins because the inner loop missed a `break` on
// successful match — producing gallery metadata bugs where e.g. a node with
// both `length` and `num_frames` picked up `num_frames`'s value over `length`.)
const NUMBER_RULES: NumberRule[] = [
  { field: 'width',     names: ['width'] },
  { field: 'height',    names: ['height'] },
  { field: 'length',    names: ['length', 'num_frames', 'frames_number', 'video_length'] },
  { field: 'fps',       names: ['fps', 'frame_rate'] },
  { field: 'seed',      names: ['seed', 'noise_seed'] },
  { field: 'steps',     names: ['steps'] },
  { field: 'cfg',       names: ['cfg', 'guidance'] },
  { field: 'denoise',   names: ['denoise'] },
  { field: 'batchSize', names: ['batch_size'] },
];

const STRING_RULES: Array<{ field: keyof ScanFields; names: string[] }> = [
  { field: 'sampler',   names: ['sampler_name'] },
  { field: 'scheduler', names: ['scheduler'] },
];

function scanToNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function scanToString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function resolveNumber(prompt: ApiPrompt, value: unknown): number | null {
  const direct = scanToNumber(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) return scanToNumber(resolveLiteral(prompt, value));
  return null;
}

function resolveString(prompt: ApiPrompt, value: unknown): string | null {
  const direct = scanToString(value);
  if (direct !== null) return direct;
  if (Array.isArray(value)) return scanToString(resolveLiteral(prompt, value));
  return null;
}

// Priority for a `*_name` input key — lower == more "main". Ensures models[0]
// is deterministically the primary diffusion weight instead of whichever node
// iteration happened to touch first (prior to this fix, re-scans could report
// VAE or CLIP as the `model` field).
function modelPriority(inputKey: string): number {
  if (inputKey === 'ckpt_name' || inputKey === 'unet_name' || inputKey === 'model_name') return 0;
  if (inputKey === 'controlnet_name' || inputKey === 'upscale_model_name' || inputKey === 'style_model_name') return 1;
  if (inputKey === 'lora_name') return 2;
  if (inputKey === 'vae_name') return 3;
  if (inputKey === 'clip_name' || inputKey === 'text_encoder') return 4;
  return 5;
}

function scanWidgets(prompt: ApiPrompt): Partial<ScanFields> {
  const out: Partial<ScanFields> = {};
  // Track the lowest (== most primary) priority seen per filename. Same
  // weight file can be referenced by multiple keys; the first-found key's
  // priority wins after canonical sorting.
  const modelPriorities = new Map<string, number>();

  for (const node of Object.values(prompt)) {
    const inputs = node?.inputs;
    if (!inputs) continue;

    for (const rule of NUMBER_RULES) {
      if (out[rule.field] != null) continue;
      for (const name of rule.names) {
        if (!(name in inputs)) continue;
        const n = resolveNumber(prompt, inputs[name]);
        if (n !== null) {
          (out[rule.field] as number) = n;
          // First-wins: stop scanning aliases on this node once we have a value.
          // Without this break, a node declaring multiple aliases let the LAST
          // match overwrite the FIRST (see NumberRule comment above).
          break;
        }
      }
    }

    for (const rule of STRING_RULES) {
      if (out[rule.field] != null) continue;
      for (const name of rule.names) {
        if (!(name in inputs)) continue;
        const s = resolveString(prompt, inputs[name]);
        if (s !== null && s !== '') {
          (out[rule.field] as string) = s;
          break;
        }
      }
    }

    for (const [key, raw] of Object.entries(inputs)) {
      if (!key.endsWith('_name') && key !== 'text_encoder') continue;
      const s = resolveString(prompt, raw);
      if (!s || !MODEL_EXT_RX.test(s)) continue;
      const pri = modelPriority(key);
      const prev = modelPriorities.get(s);
      if (prev === undefined || pri < prev) modelPriorities.set(s, pri);
    }
  }

  if (modelPriorities.size > 0) {
    out.models = [...modelPriorities.entries()]
      .sort(([aName, aPri], [bName, bPri]) => aPri - bPri || aName.localeCompare(bName))
      .map(([name]) => name);
  }
  return out;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

const KSAMPLER_TYPES = new Set(['KSampler', 'KSamplerAdvanced']);
const TEXT_ENCODE_RX = /TextEncode/i;
// Wire-chase depth cap matches MAX_DEPTH. Stock LTX 2.3 chains are ~4 hops
// (KSampler → CLIPTextEncode → TextGenerateLTX2Prompt → PrimitiveStringMultiline);
// user reroutes can add more.
const PROMPT_CHASE_MAX_DEPTH = 10;
// Inputs we follow when chasing a prompt wire backward through encoders / generators.
// Listed in priority order: `prompt` is the convention for TextGenerate* and similar
// wrappers; `text` is the CLIP convention; `value` is the Primitive* convention.
const PROMPT_WIRE_INPUT_NAMES = ['prompt', 'text', 'value'];

/**
 * Domain-specific encoder nodes that don't use CLIP's `text` convention.
 * For each class pattern, try the listed fields in order — the first one
 * holding a non-empty literal becomes the promptText.
 *
 * - `TextEncodeAceStepAudio*` (ACE-Step audio): `tags` beats `lyrics` for
 *   stock search because it's concrete keywords.
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
 * non-empty string literal we land on, or null.
 *
 * This is the missing link for modern LTX 2.3 / Wan / Hunyuan workflows
 * where the user's typed prompt sits in a PrimitiveStringMultiline that
 * feeds a TextGenerateLTX2Prompt that feeds the positive CLIPTextEncode.
 */
function chasePromptWire(prompt: ApiPrompt, value: unknown, depth = 0): string | null {
  if (depth > PROMPT_CHASE_MAX_DEPTH) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (!Array.isArray(value)) return null;
  const id = wireTargetId(value);
  if (!id) return null;
  const node = prompt[id];
  if (!node?.class_type) return null;
  const lit = resolveLiteral(prompt, value, depth);
  if (typeof lit === 'string' && lit.trim() !== '') return lit;
  if (UI_ONLY_TYPES.has(node.class_type)) {
    const first = Object.values(node.inputs ?? {})[0];
    return chasePromptWire(prompt, first, depth + 1);
  }
  const inputs = node.inputs ?? {};
  for (const name of PROMPT_WIRE_INPUT_NAMES) {
    if (!(name in inputs)) continue;
    const next = (inputs as Record<string, unknown>)[name];
    const chased = chasePromptWire(prompt, next, depth + 1);
    if (chased !== null) return chased;
  }
  return null;
}

/**
 * Collect encoder node IDs whose output flows into ANY sampler-like node's
 * `negative` slot (directly or via pass-through nodes). Used to exclude them
 * from the longest-literal heuristic so a long negative default doesn't get
 * mislabelled as the user's prompt.
 */
function collectNegativeEncoderIds(prompt: ApiPrompt): Set<string> {
  const out = new Set<string>();
  const visit = (id: string | null, depth: number): void => {
    if (!id || depth > PROMPT_CHASE_MAX_DEPTH) return;
    const node = prompt[id];
    if (!node?.class_type) return;
    if (node.class_type === 'CLIPTextEncode') { out.add(id); return; }
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

// Classic heuristic fallback — longest CLIPTextEncode string wins, excluding
// identified negative-conditioning encoders.
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

  // Step 2: longest literal CLIPTextEncode, EXCLUDING negative encoders.
  // Without that exclusion workflows that wire the positive and leave a long
  // negative-prompt default would mistakenly label the negative as the user prompt.
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
 * Negative prompt resolution. When a KSampler exists we follow its
 * `negative` wire to a CLIPTextEncode; unresolved wires default to empty
 * string (matches the Wave-F back-compat contract where "no negative"
 * vs "negative resolution failed" are distinguishable from null).
 * When no KSampler is present, pick any CLIPTextEncode literal that
 * differs from the positive.
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
  // Importer paths (syncFromComfyUI etc.) only have the API prompt — ComfyUI's
  // /history doesn't return the workflow JSON. Walk API-prompt Primitives by
  // `_meta.title` so role-name extraction works regardless of which payload reached us.
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
  // so the tail fallback was guaranteed to return null whenever wiredPrompt was null — redundant.
  const wiredPrompt = resolvePromptText(apiPrompt);
  out.promptText = titlePrompt ?? wiredPrompt;
  const wiredNegative = resolveNegative(apiPrompt, out.promptText);
  out.negativeText = titleNegative ?? wiredNegative;

  const models = scanFields.models ?? [];
  out.models = models;
  // `model` is the back-compat single-field alias: first discovered weight file,
  // preferring checkpoints. Scan order walks Object.values(prompt) — stable within a run.
  out.model = models[0] ?? null;

  out.durationMs = durationFromStatus(statusMessages);
  return out;
}

/**
 * Walk the prompt in-place and replace `seed`/`noise_seed` on every
 * KSampler variant with a new random int. Used by the regenerate endpoint.
 *
 * NOT the same as `randomizeSeeds` in `workflow/prompt/inject.ts` — this
 * one is aggressive (seed+noise_seed on every KSampler node) and uses
 * `0xffffffff`; the inject one is class-specific and uses `2147483647`.
 * Keeping them intentionally different matches the different call-site needs.
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
