// Plugin dependency analyzer + fixer. Ports launcher's python.controller
// `analyzePluginDependencies` + `fixPluginDependencies`.
//
// All directory walks go through `safeResolve` so a hostile plugin id cannot
// coerce the scanner into reading files outside the custom_nodes tree.

import fs from 'fs';
import path from 'path';
import { safeResolve } from '../../lib/fs.js';
import { logger } from '../../lib/logger.js';
import { getPluginsRoot, getPluginPath } from '../plugins/locations.js';
import { listInstalledPackages, installRequirements, type InstalledPackage } from './packages.service.js';

export interface DependencyItem {
  name: string;
  version: string;
  missing?: boolean;
  versionMismatch?: boolean;
}

export interface PluginDependencyReport {
  plugin: string;
  dependencies: DependencyItem[];
  missingDeps: string[];
}

/** Parse a requirements.txt body into { name, version-spec } entries. */
/**
 * Evaluate a PEP 508 environment marker against the current runtime.
 * Supports the markers seen in the wild in ComfyUI custom node
 * requirements.txt files: `platform_system`, `platform_machine`,
 * `python_version`. Unknown / unparseable markers default to `true` so we
 * never silently drop a requirement we don't understand.
 */
function evalMarker(marker: string): boolean {
  const m = marker.trim();
  if (!m) return true;
  const platformSystem =
    process.platform === 'linux' ? 'Linux'
      : process.platform === 'darwin' ? 'Darwin'
        : process.platform === 'win32' ? 'Windows'
          : '';
  const platformMachine = process.arch === 'x64' ? 'x86_64' : process.arch;
  const match = m.match(
    /^(platform_system|platform_machine|sys_platform)\s*(==|!=)\s*["']([^"']+)["']$/,
  );
  if (!match) return true;
  const key = match[1];
  const op = match[2];
  const value = match[3];
  const actual = key === 'platform_system' ? platformSystem
    : key === 'platform_machine' ? platformMachine
      : key === 'sys_platform' ? process.platform
        : '';
  return op === '==' ? actual === value : actual !== value;
}

export function parseRequirements(content: string): DependencyItem[] {
  const deps: DependencyItem[] = [];
  const rawLines = content
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter((line) => line.length > 0);
  for (const raw of rawLines) {
    // Split PEP 508 marker. Without the split, markers leak into the version
    // spec and `isCompatible()` reports spurious versionMismatch (e.g.
    // `pynini==2.1.6; platform_system!="Windows"` leaked the marker as part
    // of the version). We also evaluate the marker against the current
    // platform so `wetext; platform_system == "Darwin"` is skipped on Linux.
    const [spec, marker = ''] = raw.split(';').map((s) => s.trim());
    if (!evalMarker(marker)) continue;
    const match = spec.match(/^([a-zA-Z0-9_\-]+)([<>=!~].+)?$/);
    if (match) deps.push({ name: match[1], version: match[2] || '' });
  }
  return deps;
}

/** Very loose compatibility check: only strict `==X.Y.Z` is enforced. */
export function isCompatible(installed: string, required: string): boolean {
  if (required.startsWith('==')) return installed === required.substring(2);
  return true;
}

function matchInstalled(
  name: string,
  installed: InstalledPackage[],
): InstalledPackage | undefined {
  const norm = name.toLowerCase();
  return installed.find((p) => {
    const pn = p.name.toLowerCase();
    return pn === norm || pn === norm.replace(/-/g, '_') || pn === norm.replace(/_/g, '-');
  });
}

/** List installed plugins by walking the custom_nodes root under `safeResolve`. */
function listPluginIds(): string[] {
  const root = getPluginsRoot();
  if (!root) return [];
  try {
    const dir = safeResolve(root);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch (err) {
    logger.warn('plugin root walk failed', { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** Read a plugin's requirements.txt safely; returns '' if absent. */
function readRequirements(pluginId: string): string {
  const p = getPluginPath(pluginId);
  if (!p) return '';
  try {
    const req = safeResolve(p, 'requirements.txt');
    if (!fs.existsSync(req)) return '';
    return fs.readFileSync(req, 'utf-8');
  } catch { return ''; }
}

/** Per-plugin dependency report used by GET /api/python/plugins/dependencies. */
export async function analyzePluginDependencies(): Promise<PluginDependencyReport[]> {
  const installed = await listInstalledPackages();
  const out: PluginDependencyReport[] = [];
  for (const plugin of listPluginIds()) {
    const content = readRequirements(plugin);
    if (!content) { out.push({ plugin, dependencies: [], missingDeps: [] }); continue; }
    const deps = parseRequirements(content);
    const missing: string[] = [];
    for (const dep of deps) {
      const match = matchInstalled(dep.name, installed);
      if (!match) { dep.missing = true; missing.push(dep.name); }
      else if (dep.version && !isCompatible(match.version, dep.version)) {
        dep.versionMismatch = true;
        missing.push(dep.name);
      }
    }
    out.push({ plugin, dependencies: deps, missingDeps: missing });
  }
  return out;
}

/** Run `pip install -r requirements.txt` for a single plugin. */
export async function fixPluginDependencies(
  pluginId: string,
): Promise<{ output: string }> {
  if (!pluginId) throw new Error('Plugin name is required');
  const dir = getPluginPath(pluginId);
  if (!dir) throw new Error('Plugin not found');
  // safeResolve guarantees the requirements.txt lives under the plugin dir.
  const req = safeResolve(dir, 'requirements.txt');
  if (!fs.existsSync(req)) throw new Error('Plugin has no requirements.txt');
  return installRequirements(req);
}

export { path };
