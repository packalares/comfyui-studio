// Pure dep extraction from a template's workflow document.
//
// Used by two callers:
//   1. `dependencies.routes.ts /check-dependencies` — list missing models.
//   2. `templates.service.ts` boot-time loader + `/templates/refresh` — cache
//      each template's required models + plugins into sqlite.
//
// Model extraction reproduces the original logic from the check-dependencies
// handler 1:1 (node-level `properties.models[]` + loader-node widget_values
// filename scan through `collectAllWorkflowNodes` so nested subgraph loaders
// aren't missed).
//
// Plugin extraction is best-effort: ComfyUI Manager stamps each custom node
// with `properties.aux_id` (usually the plugin's github "owner/repo"
// identifier) and sometimes `properties.cnr_id`. We collect both, dedup, and
// leave resolution to the catalog layer.

import { collectAllWorkflowNodes } from '../workflow/collect.js';
import { LOADER_TYPES, UI_ONLY_TYPES } from '../workflow/constants.js';
import { getObjectInfo } from '../workflow/objectInfo.js';
import type { WorkflowNode } from '../../contracts/workflow.contract.js';

// Static fallback of ComfyUI core + UI-only node types. Used when
// `/api/object_info` is unreachable so the plugin resolver never asks
// Manager to locate a repo for a built-in node. Superset of
// `UI_ONLY_TYPES`; additions here must actually ship with ComfyUI core.
const STATIC_BUILTIN_CLASSES = new Set<string>([
  ...UI_ONLY_TYPES,
  'Note',
  'MarkdownNote',
  'Anchor',
  'Subgraph',
]);

export interface ExtractedDeps {
  models: string[];
  plugins: string[];
}

/**
 * ComfyUI-core class types that ship with a stock install. Any workflow
 * class_type that lives in `/api/object_info` comes from ComfyUI's own
 * node registry, not from a custom-node pack — so we exclude it from the
 * Manager-resolution set to avoid 1000+ wasted lookups per workflow.
 *
 * Seeded lazily from `getObjectInfo()` on first access so tests can seed
 * the cache via `seedObjectInfoCache()`. When object_info is unreachable
 * (ComfyUI offline), the exclusion set stays empty and every class_type
 * is considered a candidate — the Manager resolver then either matches
 * or returns zero-match unresolved rows, which is still correct output.
 */
async function loadBuiltinClassTypes(): Promise<Set<string>> {
  const info = await getObjectInfo();
  const builtins = new Set<string>();
  for (const key of Object.keys(info)) {
    if (typeof key === 'string' && key.length > 0) builtins.add(key);
  }
  return builtins;
}

const MODEL_FILE_EXT = /\.(safetensors|pth|ckpt|pt|bin)$/i;

function readStringProp(node: WorkflowNode, key: string): string | undefined {
  const props = (node as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return undefined;
  const val = (props as Record<string, unknown>)[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function collectNodeTemplateModels(node: WorkflowNode, out: Set<string>): void {
  const props = (node as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return;
  const arr = (props as { models?: unknown }).models;
  if (!Array.isArray(arr)) return;
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const name = (raw as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) out.add(name);
  }
}

function collectLoaderFilenames(node: WorkflowNode, out: Set<string>): void {
  const nodeType = (node.type as string | undefined)
    || (node.class_type as string | undefined)
    || '';
  if (!LOADER_TYPES.has(nodeType)) return;
  if (!Array.isArray(node.widgets_values)) return;
  for (const val of node.widgets_values) {
    if (typeof val !== 'string') continue;
    if (!MODEL_FILE_EXT.test(val)) continue;
    out.add(val);
  }
}

function collectNodePlugin(node: WorkflowNode, out: Set<string>): void {
  const aux = readStringProp(node, 'aux_id');
  if (aux) out.add(normalizePluginId(aux));
  const cnr = readStringProp(node, 'cnr_id');
  if (cnr) out.add(normalizePluginId(cnr));
}

function normalizePluginId(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

/**
 * Given a workflow document (LiteGraph or raw API-prompt), return the set of
 * model filenames and plugin ids that the workflow references.
 *
 * Pure function: no catalog reads, no disk I/O, no network. Heavy
 * Manager-resolved plugin extraction lives in the async companion
 * `extractDepsWithPluginResolution` — this synchronous entry point keeps
 * the cheap `aux_id`/`cnr_id` fast path intact so boot-time diffs don't
 * depend on ComfyUI being reachable.
 */
export function extractDeps(workflow: unknown): ExtractedDeps {
  const models = new Set<string>();
  const plugins = new Set<string>();
  if (!workflow || typeof workflow !== 'object') {
    return { models: [], plugins: [] };
  }
  const nodes = collectAllWorkflowNodes(workflow as Record<string, unknown>);
  for (const node of nodes) {
    collectNodeTemplateModels(node, models);
    collectLoaderFilenames(node, models);
    collectNodePlugin(node, plugins);
  }
  return {
    models: Array.from(models).sort(),
    plugins: Array.from(plugins).sort(),
  };
}

/**
 * Walk every node (including nested subgraphs) and return the unique
 * `type` / `class_type` strings the workflow references, minus ComfyUI
 * built-ins. Consumed by the Manager resolver — `resolveNodeTypes()` only
 * needs to look up non-built-in class types.
 *
 * Async because the exclusion list is sourced from `/api/object_info`
 * which is cached but requires an initial fetch.
 */
export async function extractNodeTypes(workflow: unknown): Promise<string[]> {
  if (!workflow || typeof workflow !== 'object') return [];
  const nodes = collectAllWorkflowNodes(workflow as Record<string, unknown>);
  const builtins = await loadBuiltinClassTypes();
  const seen = new Set<string>();
  for (const node of nodes) {
    const t = (node.type as string | undefined)
      || (node.class_type as string | undefined)
      || '';
    if (!t) continue;
    if (builtins.has(t)) continue;
    // Second gate: static fallback catches core + UI-only types even when
    // ComfyUI's /api/object_info was unreachable (so `builtins` was empty).
    if (STATIC_BUILTIN_CLASSES.has(t)) continue;
    seen.add(t);
  }
  return Array.from(seen).sort();
}

/** Expose the built-in filter for tests — resolvers depend on it. */
export async function _loadBuiltinClassTypesForTests(): Promise<Set<string>> {
  return loadBuiltinClassTypes();
}
