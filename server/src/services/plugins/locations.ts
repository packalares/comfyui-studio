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

/** Resolve a plugin's directory (enabled first, fall back to disabled). Null if root empty. */
export function getPluginPath(pluginId: string): string | null {
  const root = getPluginsRoot();
  if (!root) return null;
  try {
    const enabled = safeResolve(root, pluginId);
    if (fs.existsSync(enabled)) return enabled;
  } catch { /* path escape */ }
  try {
    const disabled = safeResolve(getDisabledPluginsRoot(), pluginId);
    if (fs.existsSync(disabled)) return disabled;
  } catch { /* path escape */ }
  // Default to the enabled-path target — callers may intend this for install.
  try { return safeResolve(root, pluginId); } catch { return null; }
}

/** Convenience: absolute enabled-dir target for a plugin id (may not exist). */
export function getEnabledPluginPath(pluginId: string): string {
  const root = getPluginsRoot();
  if (!root) throw new Error('Plugin root not configured');
  return safeResolve(root, pluginId);
}

/** Convenience: absolute disabled-dir target for a plugin id (may not exist). */
export function getDisabledPluginPath(pluginId: string): string {
  const dis = getDisabledPluginsRoot();
  if (!dis) throw new Error('Plugin root not configured');
  return safeResolve(dis, pluginId);
}

/** Ensure enabled + disabled directories exist. Safe to call repeatedly. */
export function ensurePluginDirs(): void {
  const root = getPluginsRoot();
  if (!root) return;
  try { fs.mkdirSync(root, { recursive: true, mode: 0o755 }); } catch { /* best effort */ }
  const dis = getDisabledPluginsRoot();
  try { fs.mkdirSync(dis, { recursive: true, mode: 0o755 }); } catch { /* best effort */ }
}
