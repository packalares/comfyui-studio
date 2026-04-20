// On-disk plugin scanner. Reads each installed plugin's directory and returns
// merged metadata derived from pyproject.toml / setup.py / Git / requirements.
// Heavy lifting lives in `info.metadata.ts`; this file stays a thin coordinator.

import fs from 'fs';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import {
  ensurePluginDirs,
  getDisabledPluginsRoot,
  getPluginsRoot,
} from './locations.js';
import type { PluginMetadata } from './info.types.js';
import {
  readGitInfo,
  getPyprojectMetadata,
  getSetupPyMetadata,
  getPluginFileStructure,
} from './info.metadata.js';

export type { PluginMetadata } from './info.types.js';

function safeStat(p: string): { size: number; lastModified: string; installedOn: string } {
  const fallback = new Date().toISOString();
  try {
    const s = fs.statSync(p);
    return {
      size: s.size,
      lastModified: s.mtime.toISOString(),
      installedOn: s.birthtime?.toISOString?.() || fallback,
    };
  } catch { return { size: 0, lastModified: fallback, installedOn: fallback }; }
}

function mergeMetadata(pluginPath: string): Partial<PluginMetadata> {
  const py = getPyprojectMetadata(pluginPath);
  if (Object.keys(py).length > 0) return py;
  return getSetupPyMetadata(pluginPath);
}

/** Read a single plugin's metadata. Returns null when the dir does not exist. */
export function readPluginInfo(dir: string, isDisabled: boolean): PluginMetadata | null {
  try {
    const root = isDisabled ? getDisabledPluginsRoot() : getPluginsRoot();
    if (!root) return null;
    const pluginPath = safeResolve(root, dir);
    if (!fs.existsSync(pluginPath)) return null;
    const git = readGitInfo(pluginPath);
    const meta = mergeMetadata(pluginPath);
    const structure = getPluginFileStructure(pluginPath);
    const stats = safeStat(pluginPath);
    return {
      id: dir,
      name: meta.name || dir,
      description: meta.description || '',
      author: meta.author || '',
      repository: git?.repoUrl || '',
      version: meta.version || 'nv-1',
      status: 'NodeStatusActive',
      rating: 0,
      downloads: 0,
      github_stars: 0,
      license: meta.license || '{}',
      tags: [],
      dependencies: meta.dependencies || [],
      requirements: structure.requirements,
      supported_accelerators: null,
      supported_os: null,
      created_at: stats.installedOn,
      lastModified: stats.lastModified,
      installed: true,
      installedOn: stats.installedOn,
      disabled: isDisabled,
      hasInstallScript: structure.hasInstallScript,
      hasRequirementsFile: structure.hasRequirementsFile,
      size: stats.size,
    };
  } catch (err) {
    logger.warn('plugin info read failed', { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function readDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !/_backup_\d+$/.test(d.name))
      .map((d) => d.name);
  } catch { return []; }
}

/** Walk enabled + disabled plugin dirs, returning metadata per plugin. */
export function getAllInstalledPlugins(): PluginMetadata[] {
  const out: PluginMetadata[] = [];
  const root = getPluginsRoot();
  if (!root) return out;
  ensurePluginDirs();
  for (const name of readDirs(root)) {
    const info = readPluginInfo(name, false);
    if (info) out.push(info);
  }
  const disabled = getDisabledPluginsRoot();
  if (disabled && fs.existsSync(disabled)) {
    for (const name of readDirs(disabled)) {
      const info = readPluginInfo(name, true);
      if (info) out.push(info);
    }
  }
  return out;
}
