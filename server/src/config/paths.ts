// Derived filesystem roots used by services.
//
// These wrap env overrides so call sites can import a named path instead of
// reconstructing `path.join(os.homedir(), '.config', ...)` in half a dozen
// places.

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { env } from './env.js';

const STUDIO_CONFIG_ROOT = path.join(os.homedir(), '.config', 'comfyui-studio');

// Resolve `server/data/` relative to this file so bundled JSONs can be
// located at runtime without relying on CWD. `config/paths.ts` lives at
// `server/src/config/paths.ts`; `../..` climbs to `server/`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DATA_DIR = path.resolve(HERE, '..', '..', 'data');

export const paths = {
  configRoot: STUDIO_CONFIG_ROOT,
  catalogFile: env.STUDIO_CATALOG_FILE ?? path.join(STUDIO_CONFIG_ROOT, 'catalog.json'),
  configFile: env.STUDIO_CONFIG_FILE ?? path.join(STUDIO_CONFIG_ROOT, 'config.json'),
  exposedWidgetsDir: env.STUDIO_EXPOSED_WIDGETS_DIR
    ?? path.join(STUDIO_CONFIG_ROOT, 'exposed_widgets'),
  /** Absolute root of ComfyUI's model tree on disk. May be empty - stat-fallback disabled. */
  modelsDir: env.MODELS_DIR,
  /** Directory holding bundled + runtime-written JSON state for launcher ports. */
  dataDir: env.DATA_DIR || BUNDLED_DATA_DIR,
  /** Bundled plugin-catalog snapshot (tracked, read-only). */
  nodeListPath: env.NODE_LIST_PATH || path.join(BUNDLED_DATA_DIR, 'all_nodes.mirrored.json'),
  /** Mutable plugin cache written by the plugin service (runtime). */
  modelCachePath: env.MODEL_CACHE_PATH || path.join(BUNDLED_DATA_DIR, 'model-cache.json'),
  /** Mutable plugin history written by the plugin service (runtime). */
  pluginHistoryPath: env.PLUGIN_HISTORY_PATH
    || path.join(BUNDLED_DATA_DIR, '.comfyui-manager-history.json'),
  /** pip config file consumed by the python service. */
  pipConfigPath: path.join(STUDIO_CONFIG_ROOT, 'pip.conf'),
  /** Launcher system-settings (HF endpoint / GitHub proxy / pip source) persistence. */
  envConfigFile: path.join(env.DATA_DIR || BUNDLED_DATA_DIR, 'env-config.json'),
  /** Per-run network check log directory. */
  networkCheckDir: path.join(env.DATA_DIR || BUNDLED_DATA_DIR, 'network-checks'),
} as const;

export type Paths = typeof paths;
