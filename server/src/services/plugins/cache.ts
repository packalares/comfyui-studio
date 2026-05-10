// Plugin catalog cache. Reads the bundled `all_nodes.mirrored.json`, seeds
// the `plugins_catalog` sqlite table on first boot, then serves every
// lookup from sqlite. Install state is overlaid from `info.ts` each call.
//
// Also provides the "is this plugin installed?" helpers (was `installedKeys.ts`).
// Kept here rather than `info.ts` to avoid a cycle: info ← cache ← info.

import fs from 'fs';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { atomicWrite } from '../../lib/fs.js';
import { getAllInstalledPlugins } from './info.js';
import * as pluginRepo from '../../lib/db/plugins.repo.js';
import {
  getPluginsRoot,
  getDisabledPluginsRoot,
  findEnabledPluginDir,
} from './locations.js';
import {
  canonicalizeSync,
  normalizeRepoKey,
  repoBasename,
} from './nodes.js';

// ---- CatalogPlugin type + overlay helpers ----

export interface CatalogPlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  repository: string;
  version: string;
  latest_version?: unknown;
  versions?: unknown[];
  publisher?: unknown;
  status: string;
  status_detail: string;
  rating: number;
  downloads: number;
  github_stars: number;
  icon: string;
  banner_url: string;
  category: string;
  license: string;
  tags: string[];
  dependencies?: string[];
  supported_accelerators?: unknown;
  supported_comfyui_frontend_version?: string;
  supported_comfyui_version?: string;
  supported_os?: unknown;
  created_at: string;
  installed: boolean;
  installedOn?: string;
  disabled: boolean;
  install_type: string;
  stars: number;
  github: string;
}

export function entryToCatalogPlugin(info: Record<string, unknown>): CatalogPlugin {
  const latest = info.latest_version as { version?: string } | undefined;
  return {
    id: String(info.id ?? ''),
    name: String(info.name ?? ''),
    description: String(info.description ?? ''),
    author: String(info.author ?? ''),
    repository: String(info.repository ?? ''),
    version: latest?.version || 'nv-4',
    latest_version: info.latest_version,
    versions: Array.isArray(info.versions) ? info.versions : [],
    publisher: info.publisher,
    status: String(info.status ?? 'NodeStatusActive'),
    status_detail: String(info.status_detail ?? ''),
    rating: Number(info.rating ?? 0),
    downloads: Number(info.downloads ?? 0),
    github_stars: Number(info.github_stars ?? 0),
    icon: String(info.icon ?? ''),
    banner_url: String(info.banner_url ?? ''),
    category: String(info.category ?? ''),
    license: String(info.license ?? '{}'),
    tags: Array.isArray(info.tags) ? info.tags as string[] : [],
    dependencies: Array.isArray((latest as Record<string, unknown> | undefined)?.dependencies)
      ? (latest as Record<string, unknown>).dependencies as string[] : [],
    supported_accelerators: info.supported_accelerators,
    supported_comfyui_frontend_version: String(info.supported_comfyui_frontend_version ?? ''),
    supported_comfyui_version: String(info.supported_comfyui_version ?? ''),
    supported_os: info.supported_os,
    created_at: typeof info.created_at === 'string' ? info.created_at : new Date().toISOString(),
    installed: false,
    disabled: false,
    install_type: 'git_clone',
    stars: Number(info.github_stars ?? 0),
    github: String(info.repository ?? ''),
  };
}

function normalizeGithubUrl(url: string): string {
  return (url || '').toLowerCase()
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

export function overlayInstalled(
  source: CatalogPlugin[],
  installed: ReturnType<typeof getAllInstalledPlugins>,
): CatalogPlugin[] {
  const byId = new Map<string, (typeof installed)[number]>();
  const byUrl = new Map<string, (typeof installed)[number]>();
  for (const p of installed) {
    byId.set(p.id.toLowerCase(), p);
    const u = normalizeGithubUrl(p.repository || '');
    if (u) byUrl.set(u, p);
  }
  const merged = source.map((p) => {
    const local = byId.get(p.id.toLowerCase())
      ?? byUrl.get(normalizeGithubUrl(p.repository || p.github || ''));
    if (!local) return { ...p, github: p.repository || p.github };
    return {
      ...p,
      installed: true,
      installedOn: local.installedOn || p.installedOn,
      disabled: local.disabled ?? p.disabled ?? false,
      version: local.version || p.version,
      name: local.name || p.name,
      description: local.description || p.description,
      repository: local.repository || p.repository || p.github,
      github: local.repository || p.repository || p.github,
      stars: p.github_stars || p.stars,
    };
  });
  for (const local of installed) {
    const seen = merged.some((p) => p.id.toLowerCase() === local.id.toLowerCase()
      || normalizeGithubUrl(p.repository || p.github || '') === normalizeGithubUrl(local.repository || ''));
    if (!seen) {
      merged.push({
        ...entryToCatalogPlugin(local as unknown as Record<string, unknown>),
        installed: true,
        installedOn: local.installedOn,
        disabled: local.disabled,
      });
    }
  }
  return merged;
}

// ---- SQLite-backed catalog ----

const CACHE_DURATION_MS = 60 * 60 * 1000; // 1h

let cached: CatalogPlugin[] = [];
let lastFetchTime = 0;
let seedAttempted = false;

function loadMirrorJson(): Record<string, unknown>[] {
  try {
    if (!fs.existsSync(paths.nodeListPath)) {
      logger.warn('plugin mirror json missing', { path: paths.nodeListPath });
      return [];
    }
    const raw = fs.readFileSync(paths.nodeListPath, 'utf-8');
    const parsed = JSON.parse(raw) as { nodes?: Record<string, unknown>[] };
    return Array.isArray(parsed.nodes) ? parsed.nodes : [];
  } catch (err) {
    logger.error('plugin mirror load failed', { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

function seedIfEmpty(): void {
  if (seedAttempted) return;
  seedAttempted = true;
  try {
    if (pluginRepo.count() === 0) {
      const entries = loadMirrorJson();
      if (entries.length > 0) pluginRepo.upsertMany(entries);
    }
  } catch (err) {
    logger.error('plugin catalog seed failed', { message: err instanceof Error ? err.message : String(err) });
  }
}

function loadFromDb(): CatalogPlugin[] {
  seedIfEmpty();
  try {
    return pluginRepo.listAll().map((r) => entryToCatalogPlugin(r.raw));
  } catch (err) {
    logger.error('plugin catalog read failed', { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Return the merged plugin list. Cached for 1h unless forceRefresh. */
export function getAllPlugins(forceRefresh = false): CatalogPlugin[] {
  const now = Date.now();
  if (!forceRefresh && cached.length > 0 && now - lastFetchTime < CACHE_DURATION_MS) {
    cached = overlayInstalled(cached, getAllInstalledPlugins());
    return cached;
  }
  const source = loadFromDb();
  cached = overlayInstalled(source, getAllInstalledPlugins());
  lastFetchTime = now;
  return cached;
}

/** Clear the cache. Called after install/uninstall so next read re-scans disk. */
export function clearCache(): void {
  cached = [];
  lastFetchTime = 0;
}

/** Clear the cache entry for a specific plugin id (global reset in practice). */
export function clearPluginCache(_pluginId: string): void {
  clearCache();
}

/** Refresh on-disk installed plugin info and re-overlay onto cached catalog. */
export function refreshInstalledPlugins(): ReturnType<typeof getAllInstalledPlugins> {
  const installed = getAllInstalledPlugins();
  if (cached.length > 0) cached = overlayInstalled(cached, installed);
  return installed;
}

export function getCacheStatus(): { count: number; lastUpdate: number; isValid: boolean } {
  return {
    count: cached.length,
    lastUpdate: lastFetchTime,
    isValid: Date.now() - lastFetchTime < CACHE_DURATION_MS,
  };
}

/**
 * Overwrite the bundled mirror file AND the sqlite catalog table. Used by
 * POST /api/plugins/update-cache.
 */
export function writeMirror(nodes: Record<string, unknown>[]): void {
  atomicWrite(paths.nodeListPath, JSON.stringify({ nodes }, null, 2), { mode: 0o644 });
  try { pluginRepo.upsertMany(nodes); }
  catch (err) {
    logger.error('plugin catalog reseed failed', { message: err instanceof Error ? err.message : String(err) });
  }
  clearCache();
  seedAttempted = true;
}

/**
 * Force-reseed sqlite from the current mirror JSON and drop the in-memory
 * overlay cache. Invoked by POST /api/plugins/update-cache even when the
 * mirror itself hasn't changed, so the two stores never drift.
 */
export function reseedFromMirror(): number {
  const entries = loadMirrorJson();
  let n = 0;
  try { n = pluginRepo.upsertMany(entries); }
  catch (err) {
    logger.error('plugin catalog reseed failed', { message: err instanceof Error ? err.message : String(err) });
  }
  clearCache();
  seedAttempted = true;
  return n;
}

// ---- "Is installed?" helpers (was installedKeys.ts) ----
//
// Lives here rather than info.ts to avoid a cycle: info ← cache ← info.
// Both helpers are needed by templates/* and routes/templates.overlay.ts.

interface InstalledKeys {
  /** Every installed form (id, owner/repo, basename) for membership tests. */
  set: Set<string>;
  byCanonical: Set<string>;
}

/** Walk the plugins-root tree and return lowercased subfolder names. */
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
        // Disabled plugins ARE installed for our purposes (code is on disk).
        out.add(dirent.name.toLowerCase());
      }
    } catch { /* unreadable */ }
  }
  return out;
}

/**
 * Build the union of installed plugin keys from both the catalog overlay
 * (respects `disabled` flag) and a direct disk scan (catches catalog-missing
 * plugins like `was-node-suite-comfyui`). Keys are stored in three forms
 * (id, owner/repo, basename) so callers can test without pre-canonicalizing.
 */
export function getInstalledPluginKeys(): InstalledKeys {
  const set = new Set<string>();
  const byCanonical = new Set<string>();

  for (const p of getAllPlugins()) {
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

  for (const name of diskPluginNames()) {
    set.add(name);
    byCanonical.add(name);
  }

  return { set, byCanonical };
}

/**
 * Predicate: is the given plugin reference installed? Tries every reasonable
 * form of the input (raw, lowercase, basename, sync-canonicalized) against
 * the union set, then falls back to a direct directory probe for freshly
 * cloned plugins not yet in the cache.
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
