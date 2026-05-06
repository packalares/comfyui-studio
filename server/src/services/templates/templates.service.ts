// Template list cache + loader. Pulls the category index from ComfyUI's
// `/templates/index.json`, flattens each category's templates, and generates
// form inputs via the companion module. Exposes a cached accessor so other
// services can look up a template by name without re-fetching.
//
// Phase 10: on every reload, every template is also persisted into the
// sqlite `templates` + dep-graph tables so the Explore page can filter on
// readiness without reshaping the catalog at request time. The boot pass
// uses each template's declared `models` array from the index for the
// model-dep edges; plugin edges are populated by the refresh endpoint
// which additionally fetches each workflow and runs `extractDeps`.

import { generateFormInputs } from './templates.formInputs.js';
import type { TemplateData, RawCategory } from './types.js';
import { logger } from '../../lib/logger.js';
import * as templateRepo from '../../lib/db/templates.repo.js';
import { recomputeTemplateReadiness } from './dependencyCheck.js';
import { listUserWorkflows } from './userTemplates.js';

function mapCategory(
  categoryTitle: string,
  _type: string,
): 'image' | 'video' | 'audio' | '3d' | 'tools' {
  const title = categoryTitle.toLowerCase();
  if (title.includes('video')) return 'video';
  if (title.includes('audio')) return 'audio';
  if (title.includes('3d')) return '3d';
  if (title.includes('utility') || title.includes('tool')) return 'tools';
  if (title.includes('llm')) return 'tools';
  return 'image';
}

function templateSource(t: TemplateData): string {
  return t.openSource === false ? 'api' : 'open';
}

function persistTemplates(list: TemplateData[]): void {
  try {
    for (const t of list) {
      // Preserve any prior `installed` flag so a boot doesn't reset
      // readiness for templates whose deps are still satisfied.
      const prior = templateRepo.getTemplate(t.name);
      // Plugin list: catalog templates have `t.plugins` undefined at boot
      // (it's populated by the refresh endpoint's per-workflow scan).
      // User-imported workflows persist `t.plugins` in their JSON, so we
      // can carry it through here directly — without this, every boot
      // would wipe `template_plugins` for the user's imports and they'd
      // appear "ready" even when a required plugin is missing.
      const pluginRepoKeys = (t.plugins ?? [])
        .map((p) => (p.repo ?? '').toLowerCase().trim())
        .filter((s) => s.length > 0);
      templateRepo.upsertTemplate(
        {
          name: t.name,
          displayName: t.title || t.name,
          category: t.category ?? null,
          description: t.description ?? null,
          source: templateSource(t),
          tags_json: JSON.stringify(t.tags ?? []),
          installed: prior?.installed ?? false,
        },
        { models: t.models ?? [], plugins: pluginRepoKeys },
      );
    }
  } catch (err) {
    logger.error('template sqlite upsert failed', { error: String(err) });
  }
}

let cachedTemplates: TemplateData[] = [];

export async function loadTemplatesFromComfyUI(comfyuiUrl: string): Promise<void> {
  try {
    const res = await fetch(`${comfyuiUrl}/templates/index.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const categories: RawCategory[] = await res.json();
    const templates: TemplateData[] = [];

    for (const cat of categories) {
      if (!cat.templates) continue;
      const studioCat = mapCategory(cat.title, cat.type);

      for (const t of cat.templates) {
        templates.push({
          name: t.name,
          title: t.title,
          description: t.description || '',
          mediaType: t.mediaType || 'image',
          mediaSubtype: t.mediaSubtype,
          tags: t.tags || [],
          models: t.models || [],
          category: cat.title,
          studioCategory: studioCat,
          io: {
            inputs: t.io?.inputs || [],
            outputs: t.io?.outputs || [],
          },
          formInputs: generateFormInputs(t),
          thumbnail: t.thumbnail || [],
          thumbnailVariant: t.thumbnailVariant,
          size: t.size || 0,
          vram: t.vram || 0,
          usage: t.usage || 0,
          openSource: t.openSource,
          username: t.username,
          date: t.date,
          logos: t.logos,
          searchRank: t.searchRank,
        });
      }
    }

    // Merge user-imported workflows on top of the upstream catalog. Dedup by
    // template `name`: user entries win so a user workflow can overlay an
    // upstream one with the same slug. (Slugs from civitai imports carry
    // their own prefix so collisions are rare in practice.)
    const userWorkflows = listUserWorkflows();
    const byName = new Map<string, TemplateData>();
    for (const t of templates) byName.set(t.name, t);
    for (const u of userWorkflows) byName.set(u.name, u);
    cachedTemplates = Array.from(byName.values());
    logger.info(
      `Loaded ${cachedTemplates.length} templates from ComfyUI (${categories.length} categories + ${userWorkflows.length} user workflows)`,
    );
    // Sqlite upsert is intentionally NOT done here — every `/templates` GET
    // triggers this function, and upserting with the index's family-tag
    // shorthand would overwrite the deep extractions from `/refresh` and
    // reset readiness flags. Use `seedTemplatesOnce()` at boot + the refresh
    // endpoint for persistent writes.
  } catch (err) {
    logger.error('Failed to load templates from ComfyUI', { error: String(err) });
    logger.info('No upstream templates available - ComfyUI may not be running');
    // Still surface any user-imported workflows so the user's own templates
    // don't vanish when ComfyUI is offline.
    const userWorkflows = listUserWorkflows();
    if (userWorkflows.length > 0) {
      const byName = new Map<string, TemplateData>();
      for (const t of cachedTemplates) byName.set(t.name, t);
      for (const u of userWorkflows) byName.set(u.name, u);
      cachedTemplates = Array.from(byName.values());
    }
  }
}

export function getTemplates(): TemplateData[] {
  return cachedTemplates;
}

/**
 * Boot-time seed. Called once after the initial `loadTemplatesFromComfyUI`.
 * Writes the shorthand model edges + kicks off a readiness recompute. Safe to
 * call again — the repo's upsert is idempotent. Not wired to `/templates`
 * GET handler (see `loadTemplatesFromComfyUI` comment for why).
 */
export function seedTemplatesOnce(): void {
  persistTemplates(cachedTemplates);
  void recomputeTemplateReadiness(cachedTemplates.map((t) => t.name)).catch((err) => {
    logger.warn('boot readiness recompute failed', { error: String(err) });
  });
}

export function getTemplate(name: string): TemplateData | undefined {
  return cachedTemplates.find(t => t.name === name);
}

/**
 * Return the names of every template currently cached in memory. Used by the
 * refresh endpoint to detect removals (rows in sqlite that are not in the
 * fresh index).
 */
export function getTemplateNames(): string[] {
  return cachedTemplates.map((t) => t.name);
}
