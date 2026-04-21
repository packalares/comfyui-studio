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
import * as pluginCache from '../plugins/cache.service.js';
import * as pluginInstall from '../plugins/install.service.js';
import type { CatalogPlugin } from '../plugins/cache.service.js';
import type { TemplateRow } from '../../lib/db/templates.repo.js';
import { getTemplate } from './templates.service.js';
import { extractDeps } from './depExtract.js';
import { extractDepsWithPluginResolution, resolutionsToRepoKeys } from './extractDepsAsync.js';

export interface InstallMissingResult {
  queued: Array<{ pluginId: string; taskId: string }>;
  alreadyInstalled: string[];
  /** Repo keys with no matching row in the plugin catalog. */
  unknown: string[];
}

/**
 * Lazy-seed the sqlite templates row for a user-imported workflow that was
 * saved before `importCommit` started persisting the row. Looks up the
 * in-memory cache (loaded from the on-disk workflow JSON), recomputes deps,
 * upserts the row + plugin edges, returns the fresh list row.
 *
 * Returns null when the template isn't a known user workflow (genuinely
 * unknown template name).
 */
async function seedUserWorkflowRow(name: string) {
  const t = getTemplate(name);
  if (!t || !t.workflow) return null;
  const cheap = extractDeps(t.workflow);
  let pluginKeys: string[] = cheap.plugins;
  try {
    const resolved = await extractDepsWithPluginResolution(t.workflow);
    pluginKeys = resolutionsToRepoKeys(resolved.plugins);
  } catch { /* Manager offline — aux_id fallback already set */ }
  const row: TemplateRow = {
    name,
    displayName: t.title || name,
    category: t.category ?? null,
    description: t.description ?? null,
    source: t.openSource === false ? 'api' : 'open',
    workflow_json: JSON.stringify(t.workflow),
    tags_json: JSON.stringify(t.tags ?? []),
    installed: false,
  };
  templateRepo.upsertTemplate(row, { models: cheap.models, plugins: pluginKeys });
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
 */
export async function installMissingPluginsForTemplate(
  templateName: string,
): Promise<InstallMissingResult> {
  let row = templateRepo.getTemplate(templateName);
  if (!row) {
    // Fallback for legacy user-imported templates saved before the commit
    // path upserted a sqlite row. Look up the in-memory cache, extract
    // plugins from the workflow, seed the row, re-fetch.
    row = await seedUserWorkflowRow(templateName);
    if (!row) throw new Error(`Template not found: ${templateName}`);
  }
  const catalog = pluginCache.getAllPlugins(false);
  const queued: Array<{ pluginId: string; taskId: string }> = [];
  const alreadyInstalled: string[] = [];
  const unknown: string[] = [];
  // Dedup input — `template_plugins` already enforces uniqueness, but the
  // outer normalization may collapse near-duplicates.
  const seen = new Set<string>();
  for (const raw of row.plugins) {
    const key = normalizeRepoKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const match = findCatalogEntry(key, catalog);
    if (!match.plugin) {
      unknown.push(key);
      continue;
    }
    if (match.plugin.installed && !match.plugin.disabled) {
      alreadyInstalled.push(key);
      continue;
    }
    try {
      const taskId = await pluginInstall.installPlugin(
        match.plugin.id,
        match.plugin,
        undefined,
      );
      queued.push({ pluginId: match.plugin.id, taskId });
    } catch (err) {
      // Surface the failure in the unknown bucket so the UI can show it —
      // individual install errors shouldn't kill the whole batch.
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
