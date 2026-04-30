// Path helpers shared by every plugin service module. Centralized so the
// resolution rules (env.PLUGIN_PATH override, safe path traversal guard,
// enabled vs disabled directory lookup) live in one place.

import fs from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { safeResolve } from '../../lib/fs.js';

/** Absolute path to ComfyUI's `custom_nodes/` tree, or '' if unconfigured. */
export function getPluginsRoot(): string {
  if (env.PLUGIN_PATH) return env.PLUGIN_PATH;
  if (!env.COMFYUI_PATH) return '';
  return path.join(env.COMFYUI_PATH, 'custom_nodes');
}

/** Disabled-plugins subfolder under the plugins root. */
export function getDisabledPluginsRoot(): string {
  const root = getPluginsRoot();
  return root ? path.join(root, '.disabled') : '';
}

// Case-insensitive directory lookup. The pluginId from Studio's catalog is
// lowercase (CNR convention) but on-disk dirs from older Manager installs use
// PascalCase (e.g. `ComfyUI-Impact-Subpack`). Linux is case-sensitive, so a
// literal `fs.existsSync()` on the lowercase id returns false even when the
// PascalCase dir is present. This helper falls back to a `readdirSync` scan
// when the literal-case path is missing, returning the actual on-disk path.
// Returns null when neither the literal nor any case-insensitive match exists.
function findExistingDirCaseInsensitive(parentDir: string, name: string): string | null {
  try {
    const literal = safeResolve(parentDir, name);
    if (fs.existsSync(literal)) return literal;
  } catch { /* path escape */ }
  try {
    const entries = fs.readdirSync(parentDir);
    const lower = name.toLowerCase();
    const match = entries.find(e => e.toLowerCase() === lower);
    if (match) {
      try { return safeResolve(parentDir, match); } catch { /* path escape */ }
    }
  } catch { /* parent missing */ }
  return null;
}

/** Resolve a plugin's directory (enabled first, fall back to disabled). Null if root empty.
 *  Case-insensitive: matches PascalCase on-disk dirs against lowercase CNR ids. */
export function getPluginPath(pluginId: string): string | null {
  const root = getPluginsRoot();
  if (!root) return null;
  const enabledHit = findExistingDirCaseInsensitive(root, pluginId);
  if (enabledHit) return enabledHit;
  const dis = getDisabledPluginsRoot();
  if (dis) {
    const disabledHit = findExistingDirCaseInsensitive(dis, pluginId);
    if (disabledHit) return disabledHit;
  }
  // Default to the enabled-path target — callers may intend this for install.
  try { return safeResolve(root, pluginId); } catch { return null; }
}

/** Convenience: absolute enabled-dir target for a plugin id (may not exist).
 *  Returns the literal-case target — for *creating* directories. */
export function getEnabledPluginPath(pluginId: string): string {
  const root = getPluginsRoot();
  if (!root) throw new Error('Plugin root not configured');
  return safeResolve(root, pluginId);
}

/** Convenience: absolute disabled-dir target for a plugin id (may not exist).
 *  Returns the literal-case target — for *creating* directories. */
export function getDisabledPluginPath(pluginId: string): string {
  const dis = getDisabledPluginsRoot();
  if (!dis) throw new Error('Plugin root not configured');
  return safeResolve(dis, pluginId);
}

/** Find an existing enabled-dir for a plugin id, case-insensitive. Null if missing.
 *  Use this for *reading* / *moving from* the enabled location. */
export function findEnabledPluginDir(pluginId: string): string | null {
  const root = getPluginsRoot();
  return root ? findExistingDirCaseInsensitive(root, pluginId) : null;
}

/** Find an existing disabled-dir for a plugin id, case-insensitive. Null if missing.
 *  Use this for *reading* / *moving from* the disabled location. */
export function findDisabledPluginDir(pluginId: string): string | null {
  const dis = getDisabledPluginsRoot();
  return dis ? findExistingDirCaseInsensitive(dis, pluginId) : null;
}

/** Ensure enabled + disabled directories exist. Safe to call repeatedly. */
export function ensurePluginDirs(): void {
  const root = getPluginsRoot();
  if (!root) return;
  try { fs.mkdirSync(root, { recursive: true, mode: 0o755 }); } catch { /* best effort */ }
  const dis = getDisabledPluginsRoot();
  try { fs.mkdirSync(dis, { recursive: true, mode: 0o755 }); } catch { /* best effort */ }
}
