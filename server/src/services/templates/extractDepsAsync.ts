// Async dep extractor for the import staging pipeline.
//
// Unions the cheap `aux_id`/`cnr_id` hits from `extractDeps` with the
// authoritative Manager-resolved class_type hits from
// `resolveNodeTypes()`. The cheap path stays as the fast pass for
// workflows saved THROUGH Manager (they already carry `aux_id`) — the
// Manager lookup only runs for the remaining unresolved class_types.
//
// Dedup rule (see `mergeResolutions`):
//
//   - Each aux_id / cnr_id hit is promoted into a synthetic
//     `PluginResolution` with one match and `classType: '<aux_id>'`. The
//     `repo` field of that match is the aux_id itself (normalized to
//     `owner/repo`, matching the store key used by `template_plugins`).
//   - Manager-resolved rows are merged by (classType, repo). If a
//     Manager row's repo matches an aux_id row (same `owner/repo`
//     after lowercasing + trailing-slash strip), the aux_id row is
//     dropped to avoid duplicate install prompts.
//
// Output shape — `PluginResolution[]` — is the wire format the frontend's
// review step renders directly.

import { extractDeps } from './depExtract.js';
import { extractNodeTypes } from './depExtract.js';
import { resolveNodeTypes, type PluginResolution } from '../plugins/nodeMap.service.js';
import { canonicalize, dedupKey } from '../plugins/canonicalId.js';

export type { PluginResolution } from '../plugins/nodeMap.service.js';

export interface ExtractedDepsAsync {
  models: string[];
  plugins: PluginResolution[];
  /** See `ExtractedDeps.modelLoaderClasses`. */
  modelLoaderClasses: Record<string, string>;
}

// Manager returns these as placeholders for ComfyUI's own built-in node
// types. They are not installable plugins — ComfyUI ships them. Any row
// whose repo key matches a builtin is filtered out before reaching
// `template_plugins` / the install-missing flow.
const BUILTIN_REPO_KEYS = new Set<string>([
  'comfy-core',
  'comfyanonymous/comfyui',
  'comfyui',
]);

function isBuiltinRepoKey(key: string): boolean {
  return BUILTIN_REPO_KEYS.has(key);
}

function auxRepoKey(aux: string): string {
  // `collectNodePlugin` already lowercases + strips https://github.com/.
  // We repeat the strip here for inputs that came in uppercased / URL-shaped.
  return aux.trim().toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

function repoMatchKey(repo: string): string {
  return auxRepoKey(repo);
}

/**
 * Merge aux_id hits + Manager-resolved class_type hits into a single list.
 *
 * Dedup is performed on `dedupKey` (canonical owner/repo basename, with
 * CNR-id ↔ owner/repo bridging via the canonicalId cache). A row whose
 * `aux_id` is `gourieff/comfyui-reactor` and another whose `cnr_id` is
 * `comfyui-reactor` collapse to one entry — the bare-id form is dropped
 * since the Manager mapping (or a sibling aux) already covers it.
 */
function mergeResolutions(
  auxIds: string[],
  managerResolutions: PluginResolution[],
): PluginResolution[] {
  // Build the canonical-keyed cover set from Manager rows so aux entries
  // pointing at the same plugin under a different identifier shape get
  // skipped.
  const managerCovered = new Set<string>();
  for (const r of managerResolutions) {
    for (const m of r.matches) managerCovered.add(dedupKey(m.repo));
  }

  // aux_id rows that aren't covered by Manager become synthetic
  // "classType: <aux>" entries. Within the aux pass we ALSO dedup against
  // each other so cnr_id + aux_id forms of the same plugin collapse to
  // one synthetic row. The slashed (owner/repo) form wins as the surviving
  // entry because it's a valid GitHub URL.
  const auxByCanonical = new Map<string, string>();
  for (const aux of auxIds) {
    const key = auxRepoKey(aux);
    if (!key) continue;
    if (managerCovered.has(dedupKey(key))) continue;
    if (isBuiltinRepoKey(key)) continue;
    const dk = dedupKey(key);
    const existing = auxByCanonical.get(dk);
    if (!existing) {
      auxByCanonical.set(dk, key);
    } else if (key.includes('/') && !existing.includes('/')) {
      auxByCanonical.set(dk, key);
    }
  }

  const auxOnly: PluginResolution[] = [];
  for (const surviving of auxByCanonical.values()) {
    auxOnly.push({
      classType: surviving,
      matches: [{ repo: surviving, title: surviving }],
    });
  }

  // Stable order: Manager rows first (grouped by class_type ASC), then
  // aux-only fallbacks (grouped by aux id ASC). The deterministic shape
  // keeps manifest diffs readable.
  const sortedManager = [...managerResolutions]
    .sort((a, b) => a.classType.localeCompare(b.classType));
  const sortedAux = auxOnly
    .sort((a, b) => a.classType.localeCompare(b.classType));
  return [...sortedManager, ...sortedAux];
}

/**
 * Full async extractor used by the staging + refresh pipelines. Pure
 * function in spirit — it reaches `resolveNodeTypes()` which caches the
 * Manager fetch internally, so repeated calls don't hammer ComfyUI.
 */
export async function extractDepsWithPluginResolution(
  workflow: unknown,
): Promise<ExtractedDepsAsync> {
  const cheap = extractDeps(workflow);
  const classTypes = await extractNodeTypes(workflow);
  const managerResolutions = classTypes.length > 0
    ? await resolveNodeTypes(classTypes)
    : [];
  // Pre-warm the canonical-id cache for every reference about to enter
  // the dedup loop so `dedupKey` reads from cache.
  const refs = new Set<string>();
  for (const id of cheap.plugins) refs.add(id);
  for (const r of managerResolutions) for (const m of r.matches) refs.add(m.repo);
  await Promise.all(Array.from(refs).map((r) => canonicalize(r)));
  return {
    models: cheap.models,
    plugins: mergeResolutions(cheap.plugins, managerResolutions),
    modelLoaderClasses: cheap.modelLoaderClasses,
  };
}

/**
 * Wire-shape helper: reduce a `PluginResolution[]` to the set of repo URLs
 * (deduped, normalized) suitable for `template_plugins` storage. Used by
 * the refresh + commit paths where we only persist edges — the full
 * resolution detail stays in the TemplateData blob for the UI.
 */
export function resolutionsToRepoKeys(plugins: PluginResolution[]): string[] {
  const out = new Set<string>();
  for (const r of plugins) {
    if (r.matches.length === 0) continue;
    for (const m of r.matches) {
      const key = repoMatchKey(m.repo);
      if (key.length === 0) continue;
      if (isBuiltinRepoKey(key)) continue;
      out.add(key);
    }
  }
  return Array.from(out).sort();
}
