// Wire resolution helpers for the gallery metadata extractor.
//
// ComfyUI's API-format prompt encodes inter-node references as
// `[nodeId, outputIndex]` arrays. Modern subgraph/video workflows chain
// these through Primitive holders, Reroutes, and trivial math
// expressions (e.g. "width/2") before the value lands on a sampler
// input. We chase the chain here and return either a literal value or
// null when the expression is too complex to evaluate statically.

import { logger } from '../lib/logger.js';
import { UI_ONLY_TYPES } from './workflow/constants.js';
import type { ApiPrompt, ApiPromptNode } from './gallery.extract.types.js';

// Depth cap for wire-chase recursion. Stock LTX-2.3 workflows already nest
// 4 hops (TextGenerate → PrimitiveString → SubgraphOutput → SubgraphInput
// → CLIPTextEncode); user reroutes or extra primitives push past that.
// 10 is well above any realistic authored chain while still preventing a
// pathological loop from stack-overflowing.
const MAX_DEPTH = 10;

const PRIMITIVE_TYPES = new Set<string>([
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
 * null when the chain can't be reduced (complex math, cycles, unknown
 * wrapper types).
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

  if (PRIMITIVE_TYPES.has(node.class_type)) {
    return primitiveValue(node);
  }
  if (UI_ONLY_TYPES.has(node.class_type)) {
    // Pass-through: follow the first input as the value source.
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
 * Used by prompt-text resolution: the caller wants the node that actually
 * emitted the string (e.g. a TextGenerate* node upstream of a Gemma clip)
 * rather than the literal value, so we stop at the first "meaningful"
 * class rather than reducing to a literal.
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
