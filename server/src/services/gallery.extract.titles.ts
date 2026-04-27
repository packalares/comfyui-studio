// Primitive*-title walk over the raw workflow JSON.
//
// Modern subgraph workflows (LTX2, Wan, Hunyuan, ...) expose the user-
// facing knobs as PrimitiveInt/Float/Boolean/String nodes whose `title`
// names the role ("Width", "Height", "Frame Rate", "Prompt", ...). These
// are the single most reliable source of semantics because:
//   1. The title is authored by the workflow creator for humans.
//   2. The `widgets_values[0]` holds the literal the user set.
//   3. Wire-chasing from the sampler back through subgraph boundaries is
//      fragile; reading the primitives directly sidesteps that entirely.

import type { ApiPrompt, TitleFields } from './gallery.extract.types.js';
import { collectAllNodes, type WorkflowWithSubgraphs } from './workflow/walkNodes.js';

interface WorkflowNode {
  type?: string;
  title?: string;
  widgets_values?: unknown[];
}

const PRIMITIVE_TYPES = new Set<string>([
  'PrimitiveInt', 'PrimitiveFloat', 'PrimitiveBoolean',
  'PrimitiveString', 'PrimitiveStringMultiline',
]);

interface TitleRule {
  pattern: RegExp;
  field: keyof TitleFields;
  kind: 'number' | 'string' | 'boolean';
}

const TITLE_RULES: TitleRule[] = [
  { pattern: /^width$/i,                field: 'width',      kind: 'number' },
  { pattern: /^height$/i,               field: 'height',     kind: 'number' },
  { pattern: /^(length|frames?)$/i,     field: 'length',     kind: 'number' },
  { pattern: /^(fps|frame ?rate)$/i,    field: 'fps',        kind: 'number' },
  { pattern: /^steps?$/i,               field: 'steps',      kind: 'number' },
  { pattern: /^(cfg|guidance)$/i,       field: 'cfg',        kind: 'number' },
  { pattern: /^denoise$/i,              field: 'denoise',    kind: 'number' },
  { pattern: /^batch ?size$/i,          field: 'batchSize',  kind: 'number' },
  { pattern: /^(seed|noise ?seed)$/i,   field: 'seed',       kind: 'number' },
  { pattern: /^sampler$/i,              field: 'sampler',    kind: 'string' },
  { pattern: /^scheduler$/i,            field: 'scheduler',  kind: 'string' },
  { pattern: /^prompt$/i,               field: 'promptText', kind: 'string' },
  { pattern: /^negative ?prompt$/i,     field: 'negativeText', kind: 'string' },
];

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function toString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}


function applyTitleRule(
  out: Partial<TitleFields>,
  title: string,
  literal: unknown,
): void {
  for (const rule of TITLE_RULES) {
    if (!rule.pattern.test(title)) continue;
    if (out[rule.field] != null) return;
    if (rule.kind === 'number') {
      const n = toNumber(literal);
      if (n !== null) (out[rule.field] as unknown) = n;
    } else if (rule.kind === 'string') {
      const s = toString(literal);
      if (s !== null && s !== '') (out[rule.field] as unknown) = s;
    }
    return;
  }
}

/**
 * Walk every Primitive* node across the workflow + its subgraph defs,
 * match node titles against the known role patterns, and record the
 * literal from widgets_values[0]. Returns a partial TitleFields record —
 * the orchestrator merges it into the final metadata with precedence
 * over widget-name scanning.
 */
export function extractFromTitles(workflowJson: unknown): Partial<TitleFields> {
  if (!workflowJson || typeof workflowJson !== 'object') return {};
  const out: Partial<TitleFields> = {};
  for (const node of collectAllNodes(workflowJson as WorkflowWithSubgraphs<WorkflowNode>)) {
    if (!node.type || !PRIMITIVE_TYPES.has(node.type)) continue;
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
 * the gallery importer's syncFromComfyUI path (and any other path that
 * has only the ComfyUI history payload — `workflowJson` unavailable).
 *
 * API-prompt nodes carry their authored title in `_meta.title` and their
 * literal in `inputs.value` (Primitive*) — same role-name semantics as
 * the workflow JSON walker, different shape. Without this fallback the
 * importer's title pass returns empty, the wire-chase fails on encoders
 * whose `text` is wired through TextGenerate*, and the longest-literal
 * heuristic mistakenly picks the negative encoder's default ("pc game,
 * console game, …" in LTX 2.3 i2av) as the prompt label.
 */
export function extractFromApiPromptTitles(prompt: ApiPrompt | null | undefined): Partial<TitleFields> {
  if (!prompt || typeof prompt !== 'object') return {};
  const out: Partial<TitleFields> = {};
  for (const node of Object.values(prompt)) {
    const classType = node?.class_type;
    if (!classType || !PRIMITIVE_TYPES.has(classType)) continue;
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
