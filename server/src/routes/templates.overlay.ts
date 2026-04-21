// Helpers for `templates.routes.ts` list-time enrichment. Split out to keep
// the routes file under the structure-test line cap.
//
// - `attachReady` attaches the readiness flag (sourced from sqlite) and
//   overlays the plugin catalog's installed state onto each TemplateData.
// - `BUILTIN_PLUGIN_KEYS` strips ComfyUI's core placeholder repo keys from
//   the plugin list — they are not installable plugins and leak into
//   older stored rows.

import * as templateRepo from '../lib/db/templates.repo.js';
import * as pluginCache from '../services/plugins/cache.service.js';
import type { TemplateData, TemplatePluginEntry } from '../services/templates/index.js';

export interface TemplateWithReady extends TemplateData {
  ready: boolean;
}

// ComfyUI's core node types surface as these repo keys from Manager. They
// ship with ComfyUI so they are neither "missing" nor installable — strip
// them from the serving list regardless of what the DB row says. The DB will
// reseed without these on the next dep extraction (see extractDepsAsync).
const BUILTIN_PLUGIN_KEYS = new Set<string>([
  'comfy-core',
  'comfyanonymous/comfyui',
  'comfyui',
]);

function normalizeRepoKey(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

function loadReadinessMap(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  try {
    const { items, total } = templateRepo.listPaginated({ ready: 'all' }, 1, 100_000);
    for (const row of items) map.set(row.name, row.installed);
    if (total > items.length) return map; // paranoia cap
  } catch {
    /* readiness unavailable => empty map => ready:false for all */
  }
  return map;
}

function loadInstalledPluginKeys(): Set<string> {
  const out = new Set<string>();
  try {
    for (const p of pluginCache.getAllPlugins(false)) {
      if (!p.installed || p.disabled) continue;
      const repo = normalizeRepoKey(p.repository || p.github || '');
      if (repo) out.add(repo);
      if (p.id) out.add(p.id.toLowerCase());
    }
  } catch { /* plugin cache unavailable => everything treated as not-installed */ }
  return out;
}

function overlayPluginInstalled(
  plugins: TemplatePluginEntry[] | undefined,
  installed: Set<string>,
): TemplatePluginEntry[] | undefined {
  if (!plugins || plugins.length === 0) return plugins;
  return plugins
    .map((p) => ({ entry: p, key: normalizeRepoKey(p.repo || '') }))
    .filter(({ key }) => key.length > 0 && !BUILTIN_PLUGIN_KEYS.has(key))
    .map(({ entry, key }) => {
      const isInstalled = installed.has(key) ||
        (entry.cnr_id ? installed.has(entry.cnr_id.toLowerCase()) : false);
      return { ...entry, installed: isInstalled };
    });
}

export function attachReady(list: TemplateData[]): TemplateWithReady[] {
  const readyMap = loadReadinessMap();
  const installedPlugins = loadInstalledPluginKeys();
  return list.map((t) => ({
    ...t,
    ready: readyMap.get(t.name) ?? false,
    plugins: overlayPluginInstalled(t.plugins, installedPlugins),
  }));
}
