// Plugin catalog cache. Reads the bundled `all_nodes.mirrored.json`, overlays
// local install state from `info.service`, and exposes `getAllPlugins`.
//
// The launcher had two data sources (local mirror + `ComfyUI-Manager` JSON);
// the studio ships the mirror as a bundled data file
// (`server/data/all_nodes.mirrored.json`) and no longer fetches the upstream
// manager list over the network by default. The `update-cache` endpoint
// remains a no-op-compatible stub for compatibility with older clients.

import fs from 'fs';
import { paths } from '../../config/paths.js';
import { logger } from '../../lib/logger.js';
import { atomicWrite } from '../../lib/fs.js';
import { getAllInstalledPlugins } from './info.service.js';

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

const CACHE_DURATION_MS = 60 * 60 * 1000; // 1h

let cached: CatalogPlugin[] = [];
let lastFetchTime = 0;

function toCatalogPlugin(info: Record<string, unknown>): CatalogPlugin {
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

function overlayInstalled(source: CatalogPlugin[], installed: ReturnType<typeof getAllInstalledPlugins>): CatalogPlugin[] {
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
  // Add local-only plugins not in source.
  for (const local of installed) {
    const seen = merged.some((p) => p.id.toLowerCase() === local.id.toLowerCase()
      || normalizeGithubUrl(p.repository || p.github || '') === normalizeGithubUrl(local.repository || ''));
    if (!seen) {
      merged.push({
        ...toCatalogPlugin(local as unknown as Record<string, unknown>),
        installed: true,
        installedOn: local.installedOn,
        disabled: local.disabled,
      });
    }
  }
  return merged;
}

function loadFromMirror(): CatalogPlugin[] {
  try {
    if (!fs.existsSync(paths.nodeListPath)) {
      logger.warn('plugin mirror json missing', { path: paths.nodeListPath });
      return [];
    }
    const raw = fs.readFileSync(paths.nodeListPath, 'utf-8');
    const parsed = JSON.parse(raw) as { nodes?: Record<string, unknown>[] };
    const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    return nodes.map(toCatalogPlugin);
  } catch (err) {
    logger.error('plugin mirror load failed', { message: err instanceof Error ? err.message : String(err) });
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
  const source = loadFromMirror();
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

/** Overwrite the bundled mirror file. Used by POST /api/plugins/update-cache. */
export function writeMirror(nodes: Record<string, unknown>[]): void {
  atomicWrite(paths.nodeListPath, JSON.stringify({ nodes }, null, 2), { mode: 0o644 });
  clearCache();
}
