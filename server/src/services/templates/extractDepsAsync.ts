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

export type { PluginResolution } from '../plugins/nodeMap.service.js';

export interface ExtractedDepsAsync {
  models: string[];
  plugins: PluginResolution[];
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

/** Merge aux_id hits + Manager-resolved class_type hits into a single list. */
function mergeResolutions(
  auxIds: string[],
  managerResolutions: PluginResolution[],
): PluginResolution[] {
  // Build a set of repo keys the Manager resolver already covers so we can
  // drop redundant aux_id rows pointing at the same repo.
  const managerRepos = new Set<string>();
  for (const r of managerResolutions) {
    for (const m of r.matches) managerRepos.add(repoMatchKey(m.repo));
  }

  // aux_id rows that are NOT covered by Manager become synthetic
  // "classType: <aux>" entries with one match pointing at the aux repo.
  const auxOnly: PluginResolution[] = [];
  const seenAux = new Set<string>();
  for (const aux of auxIds) {
    const key = auxRepoKey(aux);
    if (seenAux.has(key)) continue;
    seenAux.add(key);
    if (managerRepos.has(key)) continue;
    if (isBuiltinRepoKey(key)) continue;
    auxOnly.push({
      classType: key,
      matches: [{
        repo: key,
        title: key,
      }],
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
  return {
    models: cheap.models,
    plugins: mergeResolutions(cheap.plugins, managerResolutions),
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
