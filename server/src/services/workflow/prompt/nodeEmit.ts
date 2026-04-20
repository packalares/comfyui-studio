// Phase 2 of the API-prompt pipeline: emit one prompt entry per real node.
// UI-only types are skipped (their contribution inlines via resolveInput),
// muted nodes (mode 2) are defensively skipped, and any class_type we
// don't have objectInfo for is silently dropped.

import { FRONTEND_ONLY_VALUES, UI_ONLY_TYPES, WIDGET_PRIMITIVES } from '../constants.js';
import type { FlatNode } from '../flatten/index.js';
import { resolveInput, type ResolveCtx } from '../resolve.js';
import type { ApiPrompt } from './types.js';

/**
 * API widget names for a node type. Connections are ALL_CAPS identifiers
 * other than the widget primitives (MODEL, IMAGE, CLIP, VAE, ...). Anything
 * else — lowercase custom types, option arrays, compound names — is a
 * widget. This avoids mis-filtering custom lowercase widget types.
 */
export function getApiWidgetNames(
  objectInfo: Record<string, Record<string, unknown>>,
  classType: string,
): string[] {
  const info = objectInfo[classType] as {
    input?: {
      required?: Record<string, unknown[]>;
      optional?: Record<string, unknown[]>;
    };
  } | undefined;
  if (!info?.input) return [];
  const names: string[] = [];
  for (const [name, spec] of Object.entries(info.input.required || {})) {
    if (!Array.isArray(spec) || spec.length === 0) continue;
    const type = spec[0];
    if (Array.isArray(type)) { names.push(name); continue; }
    if (typeof type === 'string') {
      const isUpperConnection = type === type.toUpperCase() && !WIDGET_PRIMITIVES.has(type);
      if (isUpperConnection) continue;
    }
    names.push(name);
  }
  return names;
}

// Build the inputs dict for a single API prompt entry by walking node
// inputs (resolveInput handles pass-through chains) and then filling in
// widget values with proxy overrides + objectInfo defaults.
function buildNodeInputs(
  node: FlatNode,
  info: Record<string, unknown>,
  objectInfo: Record<string, Record<string, unknown>>,
  ctx: ResolveCtx,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  for (const inp of node.inputs) {
    if (inp.link == null) continue;
    const resolved = resolveInput(inp.link, ctx);
    if (!resolved) continue;
    inputs[inp.name] = resolved.kind === 'literal'
      ? resolved.value
      : [resolved.nodeId, resolved.slot];
  }

  const apiWidgets = getApiWidgetNames(objectInfo, node.type);
  const wv = node.widgets_values.filter(v => !FRONTEND_ONLY_VALUES.has(v as string));
  const required = (info as { input?: { required?: Record<string, unknown[]> } }).input?.required || {};
  for (let i = 0; i < apiWidgets.length; i++) {
    const name = apiWidgets[i];
    if (name in inputs) continue;
    if (node.overrides && name in node.overrides) {
      inputs[name] = node.overrides[name];
      continue;
    }
    if (i < wv.length) { inputs[name] = wv[i]; continue; }
    const spec = required[name] as unknown[] | undefined;
    const cfg = spec?.[1] as Record<string, unknown> | undefined;
    if (cfg && 'default' in cfg) inputs[name] = cfg.default;
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
    const inputs = buildNodeInputs(node, info, objectInfo, ctx);
    prompt[id] = {
      class_type: node.type,
      inputs,
      _meta: { title: pickDisplayTitle(node, info) },
    };
  }
  return prompt;
}
