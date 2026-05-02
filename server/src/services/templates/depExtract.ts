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
import { UI_ONLY_TYPES } from '../workflow/constants.js';
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
  /**
   * Filename → loader-node class_type that referenced it. Used downstream
   * by the import resolver to put the file in the correct
   * `models/<folder>/` directory regardless of any URL-side heuristics.
   * When the same filename is referenced by multiple loader nodes (rare)
   * the first one wins — class_types are usually stable across duplicate
   * references (e.g. two LoraLoader nodes both pointing at the same lora).
   */
  modelLoaderClasses: Record<string, string>;
  /**
   * Filename → ComfyUI folder name parsed from `/object_info` tooltips
   * (e.g. `"detection"` for `OnnxDetectionModelLoader`'s files). Plugin
   * authors increasingly stamp the target folder into the input tooltip
   * via the `'ComfyUI/models/<folder>' -folder` convention; reading it
   * here lets us persist the exact folder the loader will look in,
   * without a hardcoded class→folder map.
   *
   * Populated only by the async wrapper `extractDepsWithPluginResolution`,
   * which already fetches `/object_info`. Sync `extractDeps` leaves this
   * empty so callers without ComfyUI access stay cheap.
   */
  modelFolders: Record<string, string>;
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

const MODEL_FILE_EXT = /\.(safetensors|pth|ckpt|pt|bin|onnx|gguf)$/i;

// kjnodes-style "I'll fetch the model from HuggingFace myself" loaders. The
// widget value on these nodes is a model selector, not a literal filename the
// user must install — the plugin downloads on first run. Skip during dep
// extraction so they don't pollute the install list.
const SELF_DOWNLOAD_PREFIX = /^DownloadAndLoad/;

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

function collectLoaderFilenames(
  node: WorkflowNode,
  out: Set<string>,
  loaderClasses: Record<string, string>,
): void {
  const nodeType = (node.type as string | undefined)
    || (node.class_type as string | undefined)
    || '';
  if (!nodeType) return;
  // Self-downloading loaders (kjnodes' DownloadAndLoadSAM2Model etc.) take a
  // model selector hint, not a literal filename. The plugin grabs whatever
  // matches from HuggingFace on first run; flagging this as a user-managed
  // dep would be a false positive.
  if (SELF_DOWNLOAD_PREFIX.test(nodeType)) return;
  if (!Array.isArray(node.widgets_values)) return;
  for (const val of node.widgets_values) {
    if (typeof val !== 'string') continue;
    if (!MODEL_FILE_EXT.test(val)) continue;
    out.add(val);
    // Record the class_type the first time we see this filename so the
    // resolver can pick the right folder. Don't overwrite — duplicates
    // typically share the class anyway and we want stable behaviour.
    if (!(val in loaderClasses)) loaderClasses[val] = nodeType;
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
  const modelLoaderClasses: Record<string, string> = {};
  const modelFolders: Record<string, string> = {};
  if (!workflow || typeof workflow !== 'object') {
    return { models: [], plugins: [], modelLoaderClasses, modelFolders };
  }
  const nodes = collectAllWorkflowNodes(workflow as Record<string, unknown>);
  for (const node of nodes) {
    collectNodeTemplateModels(node, models);
    collectLoaderFilenames(node, models, modelLoaderClasses);
    collectNodePlugin(node, plugins);
  }
  return {
    models: Array.from(models).sort(),
    plugins: Array.from(plugins).sort(),
    modelLoaderClasses,
    modelFolders,
  };
}

/**
 * `'ComfyUI/models/<folder>' -folder` convention used by plugin authors in
 * `/object_info` input tooltips. We accept the kjnodes wording as the
 * primary form and a couple of common variants so authors who phrase it
 * differently still get picked up. The captured group is the bare folder
 * name (e.g. `detection`, `loras`).
 */
const TOOLTIP_FOLDER_RE = /(?:ComfyUI\/models|models)\/([\w.\-]+)/i;

/**
 * Read the ComfyUI folder name a loader expects from its `/object_info`
 * input tooltip. Returns `undefined` when no input on the loader carries
 * a recognisable tooltip — caller falls back to the static loader-class
 * map or filename heuristics.
 */
export function folderFromObjectInfoTooltip(
  loaderClass: string,
  objectInfo: Record<string, Record<string, unknown>>,
): string | undefined {
  const node = objectInfo[loaderClass];
  if (!node) return undefined;
  const input = node.input as Record<string, unknown> | undefined;
  if (!input || typeof input !== 'object') return undefined;
  for (const sectionKey of ['required', 'optional']) {
    const fields = (input as Record<string, unknown>)[sectionKey];
    if (!fields || typeof fields !== 'object') continue;
    for (const descriptor of Object.values(fields as Record<string, unknown>)) {
      if (!Array.isArray(descriptor) || descriptor.length < 2) continue;
      // First element of a file-picker is the filename array; the second is
      // the input options object containing `tooltip`.
      if (!Array.isArray(descriptor[0])) continue;
      const opts = descriptor[1];
      if (!opts || typeof opts !== 'object') continue;
      const tooltip = (opts as { tooltip?: unknown }).tooltip;
      if (typeof tooltip !== 'string') continue;
      const m = tooltip.match(TOOLTIP_FOLDER_RE);
      if (m && m[1]) return m[1];
    }
  }
  return undefined;
}

/** Subgraph wrapper nodes carry the subgraph definition's UUID as their
 *  `type` (LiteGraph convention). They are not plugin classes — exclude
 *  them so the Manager resolver doesn't get phantom unresolved rows. */
function collectSubgraphIds(workflow: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const sgs = (workflow.definitions as Record<string, unknown> | undefined)?.subgraphs;
  if (Array.isArray(sgs)) {
    for (const sg of sgs as Array<Record<string, unknown>>) {
      const id = sg.id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

/**
 * Walk every node (including nested subgraphs) and return the unique
 * `type` / `class_type` strings the workflow references, minus ComfyUI
 * built-ins and subgraph wrapper UUIDs. Consumed by the Manager resolver —
 * `resolveNodeTypes()` only needs to look up non-built-in class types.
 *
 * Async because the exclusion list is sourced from `/api/object_info`
 * which is cached but requires an initial fetch.
 */
export async function extractNodeTypes(workflow: unknown): Promise<string[]> {
  if (!workflow || typeof workflow !== 'object') return [];
  const w = workflow as Record<string, unknown>;
  const nodes = collectAllWorkflowNodes(w);
  const builtins = await loadBuiltinClassTypes();
  const subgraphIds = collectSubgraphIds(w);
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
    if (subgraphIds.has(t)) continue;
    seen.add(t);
  }
  return Array.from(seen).sort();
}

/** Expose the built-in filter for tests — resolvers depend on it. */
export async function _loadBuiltinClassTypesForTests(): Promise<Set<string>> {
  return loadBuiltinClassTypes();
}
