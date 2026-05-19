// Bulk plugin install trigger for an imported template.
//
// Reads the `template_plugins` edges for the named template, filters out
// plugins that are already installed + enabled (via the catalog overlay),
// and queues an install task per remaining repo. Plugin install itself is
// fire-and-forget — each task surfaces its progress over
// `/plugins/progress/:taskId`, and readiness flips via the existing
// `plugin:installed` event (see `services/templates/eventSubscribers.ts`).
//
// The keys we consume are the same form written by the refresh + commit
// paths (`resolutionsToRepoKeys`): `owner/repo` lowercase, no scheme, no
// .git suffix. We match against `CatalogPlugin.repository`/`github`/`id`
// with the same normalization the plugin catalog overlay uses.

import { logger } from '../../lib/logger.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import * as pluginCache from '../plugins/cache.js';
import * as pluginInstall from '../plugins/install.js';
import type { CatalogPlugin } from '../plugins/cache.js';
import { extractDeps } from './depExtract.js';
import { extractDepsWithPluginResolution, resolutionsToRepoKeys } from './extractDepsAsync.js';
import { isPluginInstalled, getInstalledPluginKeys } from '../plugins/cache.js';
import { canonicalize, dedupKey } from '../plugins/nodes.js';
import { getUserWorkflowJson } from './userTemplates.js';
import { getUserTemplate } from './userTemplatesMeta.js';

export interface InstallMissingResult {
  queued: Array<{ pluginId: string; taskId: string }>;
  alreadyInstalled: string[];
  /** Repo keys with no matching row in the plugin catalog. */
  unknown: string[];
}

/**
 * Lazy-seed the sqlite templates row for a user-imported workflow that was
 * saved before `importCommit` started persisting the row. Reads the workflow
 * from disk, recomputes deps, upserts the row + plugin edges, returns the
 * fresh list row.
 *
 * Returns null when the template isn't a known user workflow (genuinely
 * unknown template name).
 */
async function seedUserWorkflowRow(name: string) {
  const workflow = getUserWorkflowJson(name);
  if (!workflow) return null;
  const cheap = extractDeps(workflow);
  let pluginKeys: string[] = cheap.plugins;
  try {
    const resolved = await extractDepsWithPluginResolution(workflow);
    pluginKeys = resolutionsToRepoKeys(resolved.plugins);
  } catch { /* Manager offline — aux_id fallback already set */ }
  // Pull display metadata from the disk JSON so a row seeded here looks
  // like the rest of the catalog. Without this the upsert falls back to
  // the slug as displayName, leaving the template unlabelled in the UI.
  // `studioCategory` is NOT stored — it's derived at read time from
  // media_type + category by the shared `deriveStudioCategory` helper.
  const meta = getUserTemplate(name);
  templateRepo.upsertTemplate(
    {
      name,
      displayName: meta?.title || name,
      category: meta?.category ?? null,
      description: meta?.description ?? null,
      tags_json: JSON.stringify(meta?.tags ?? []),
      installed: false,
      media_type: meta?.mediaType ?? null,
      open_source: meta?.openSource === false ? 0 : 1,
      username: meta?.username ?? null,
      thumbnail_json: meta?.thumbnail ? JSON.stringify(meta.thumbnail) : null,
    },
    { models: cheap.models, plugins: pluginKeys },
  );
  return templateRepo.getTemplate(name);
}

function normalizeRepoKey(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

function catalogRepoKey(p: CatalogPlugin): string {
  return normalizeRepoKey(p.repository || p.github || '');
}

interface MatchResult {
  plugin?: CatalogPlugin;
}

function findCatalogEntry(repoKey: string, catalog: CatalogPlugin[]): MatchResult {
  const exact = catalog.find((p) => catalogRepoKey(p) === repoKey);
  if (exact) return { plugin: exact };
  // Fall back to matching by id (Manager's `cnr_id` maps to our `id`).
  const byId = catalog.find((p) => (p.id || '').toLowerCase() === repoKey);
  return byId ? { plugin: byId } : {};
}

/**
 * Install every plugin referenced by `templateName` that isn't already
 * installed + enabled. Returns the queued tasks and classification of each
 * edge so the UI can render a per-plugin status block.
 *
 * Dedup is performed via `dedupKey` (canonical owner/repo or basename),
 * so a row that lists both `comfyui-reactor` and `gourieff/comfyui-reactor`
 * triggers a single install. Installed-state checks go through the shared
 * `isPluginInstalled` helper, which catches plugins on disk that the
 * bundled catalog snapshot doesn't know about.
 */
export async function installMissingPluginsForTemplate(
  templateName: string,
): Promise<InstallMissingResult> {
  let row = templateRepo.getTemplate(templateName);
  if (!row) {
    row = await seedUserWorkflowRow(templateName);
    if (!row) throw new Error(`Template not found: ${templateName}`);
  }
  // Pre-warm the canonical-id cache for every row's repo so the dedup
  // loop's `dedupKey` reads from the cache rather than racing CNR
  // lookups inside the loop.
  await Promise.all(row.plugins.map((p) => canonicalize(p)));

  const catalog = pluginCache.getAllPlugins(false);
  const installedKeys = getInstalledPluginKeys();
  const queued: Array<{ pluginId: string; taskId: string }> = [];
  const alreadyInstalled: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const raw of row.plugins) {
    const key = normalizeRepoKey(raw);
    if (!key) continue;
    const dkey = dedupKey(key);
    if (seen.has(dkey)) continue;
    seen.add(dkey);

    if (isPluginInstalled(key, installedKeys)) {
      alreadyInstalled.push(key);
      continue;
    }

    const match = findCatalogEntry(key, catalog);
    if (!match.plugin) {
      unknown.push(key);
      continue;
    }
    try {
      const taskId = await pluginInstall.installPlugin(
        match.plugin.id, match.plugin, undefined,
      );
      queued.push({ pluginId: match.plugin.id, taskId });
    } catch (err) {
      logger.warn('installMissingPlugins: queue failed', {
        template: templateName,
        repoKey: key,
        error: err instanceof Error ? err.message : String(err),
      });
      unknown.push(key);
    }
  }
  logger.info('installMissingPlugins: completed queue pass', {
    template: templateName,
    queued: queued.length,
    alreadyInstalled: alreadyInstalled.length,
    unknown: unknown.length,
  });
  return { queued, alreadyInstalled, unknown };
}
