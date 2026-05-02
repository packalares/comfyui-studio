// Single source of truth for "which plugins are installed".
//
// Was previously implemented inline in four places (templates.overlay.ts
// ::loadInstalledPluginKeys, readiness.ts::loadPluginsView,
// installMissingPlugins.ts::findCatalogEntry, and dependencies.routes.ts
// ::installedPluginKeys), each with its own subtly-different rules. The
// stale variants only consulted the plugin catalog overlay, so any plugin
// installed on disk but missing from the bundled catalog snapshot
// (`was-node-suite-comfyui` is the canonical example) would be reported
// as not-installed even though the directory is right there.
//
// This module fixes that drift: every consumer reads the same set, and
// the set is built from BOTH the catalog overlay AND a direct plugin-root
// directory scan. Keys are written in three forms so callers can match
// without knowing how their input was shaped:
//
//   - lowercase plugin id (catalog `id` field, e.g. "comfyui-reactor")
//   - lowercase owner/repo form (e.g. "gourieff/comfyui-reactor")
//   - bare repo basename (e.g. "comfyui-reactor")
//
// Membership testing against any of these forms returns true when the
// plugin is on disk and not disabled.

import * as pluginCache from './cache.service.js';
import {
  findEnabledPluginDir, getPluginsRoot, getDisabledPluginsRoot,
} from './locations.js';
import fs from 'fs';
import {
  canonicalizeSync, normalizeRepoKey, repoBasename,
} from './canonicalId.js';

interface InstalledKeys {
  /** Set containing every form (id, owner/repo, basename) for every
   *  installed-and-enabled plugin. Use `has(key)` for membership tests. */
  set: Set<string>;
  /** Per-canonical-key snapshot useful for callers that need to attribute
   *  installed-state to a specific entry rather than just test
   *  membership. Map<canonical owner/repo or basename, present>. */
  byCanonical: Set<string>;
}

/** Walk the plugins-root directory tree (enabled + disabled) and return
 *  the set of subfolder names (lowercased). Catches plugins on disk that
 *  the bundled catalog snapshot doesn't know about. */
function diskPluginNames(): Set<string> {
  const out = new Set<string>();
  const root = getPluginsRoot();
  if (!root || !fs.existsSync(root)) return out;
  try {
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith('.')) continue;
      out.add(dirent.name.toLowerCase());
    }
  } catch { /* unreadable */ }
  const disabled = getDisabledPluginsRoot();
  if (disabled && fs.existsSync(disabled)) {
    try {
      for (const dirent of fs.readdirSync(disabled, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        if (dirent.name.startsWith('.')) continue;
        // Disabled plugins ARE installed for our purposes (the directory
        // still satisfies the "is the code on disk" question). Callers
        // that care about disabled-vs-enabled go through the cache
        // overlay's `disabled` flag.
        out.add(dirent.name.toLowerCase());
      }
    } catch { /* unreadable */ }
  }
  return out;
}

/**
 * Build the union of installed plugin keys.
 *
 * Sources:
 *   1. `getAllPlugins()` catalog overlay — supplies (id, repo) pairs for
 *      catalog-known plugins and respects the `disabled` flag.
 *   2. Disk-direct directory scan — catches anything on disk that the
 *      catalog snapshot doesn't include (the catalog ships frozen at the
 *      image build date).
 *
 * Output keys are lowercased and stored in three forms (id, owner/repo,
 * basename) so callers can test membership with whichever shape their
 * input has, without needing to canonicalize first.
 */
export function getInstalledPluginKeys(): InstalledKeys {
  const set = new Set<string>();
  const byCanonical = new Set<string>();

  // Catalog pass.
  for (const p of pluginCache.getAllPlugins()) {
    if (!p.installed || p.disabled) continue;
    if (p.id) {
      const idKey = p.id.toLowerCase();
      set.add(idKey);
      byCanonical.add(idKey);
    }
    const repo = normalizeRepoKey(p.repository || p.github || '');
    if (repo) {
      set.add(repo);
      byCanonical.add(repo);
      const base = repoBasename(repo);
      if (base !== repo) set.add(base);
    }
  }

  // Disk pass — catches catalog-missing plugins like `was-node-suite-comfyui`.
  for (const name of diskPluginNames()) {
    set.add(name);
    byCanonical.add(name);
  }

  return { set, byCanonical };
}

/**
 * Convenience predicate: is the given plugin reference installed?
 *
 * Tries every reasonable form of the input (raw, lowercase, basename,
 * sync-canonicalized) against the union set, and finally falls back to
 * a direct directory existence probe so a freshly cloned plugin not yet
 * in the cache is still detected.
 */
export function isPluginInstalled(
  ref: string,
  keys: InstalledKeys = getInstalledPluginKeys(),
): boolean {
  const norm = normalizeRepoKey(ref);
  if (keys.set.has(norm)) return true;
  if (keys.set.has(repoBasename(norm))) return true;
  const canonical = canonicalizeSync(ref);
  if (keys.set.has(canonical)) return true;
  if (keys.set.has(repoBasename(canonical))) return true;
  // Direct probe: covers the racy moment between a clone finishing and
  // the next catalog overlay refresh.
  const root = getPluginsRoot();
  if (!root) return false;
  return findEnabledPluginDir(repoBasename(canonical)) !== null;
}
