// Derived filesystem roots used by services.
//
// These wrap env overrides so call sites can import a named path instead of
// reconstructing `path.join(os.homedir(), '.config', ...)` in half a dozen
// places.
//
// Three roots, each with a clear purpose — do NOT cross streams:
//
//   1. BUNDLED_DATA_DIR (`server/data/`) — bundled READ-ONLY seeds shipped
//      with the image (e.g. `all_nodes.mirrored.json`, `model-list.json`).
//      Overwritten on image rebuilds. Services must never write here.
//
//   2. STUDIO_CONFIG_ROOT (`~/.config/comfyui-studio/`) — user config that
//      the operator may hand-edit (catalog, config, pip.conf, widgets).
//      Persists across image rebuilds.
//
//   3. runtimeStateDir (`~/.config/comfyui-studio/runtime/`) — runtime-
//      written JSON state (plugin cache, history, download history, env
//      config, network check logs, reset logs). Lives under the same
//      persistent root as user config but is visibly separated so ops can
//      tell machine-written state from human-edited state at a glance.

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { env, currentSqliteOverride } from './env.js';

const STUDIO_CONFIG_ROOT = path.join(os.homedir(), '.config', 'comfyui-studio');
const RUNTIME_STATE_DIR = path.join(STUDIO_CONFIG_ROOT, 'runtime');

// Resolve `server/data/` relative to this file so bundled JSONs can be
// located at runtime without relying on CWD. `config/paths.ts` lives at
// `server/src/config/paths.ts`; `../..` climbs to `server/`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DATA_DIR = path.resolve(HERE, '..', '..', 'data');

export const paths = {
  configRoot: STUDIO_CONFIG_ROOT,
  /** Root for runtime-written state (persists across image rebuilds). */
  runtimeStateDir: RUNTIME_STATE_DIR,
  catalogFile: env.STUDIO_CATALOG_FILE ?? path.join(STUDIO_CONFIG_ROOT, 'catalog.json'),
  /**
   * Local cache of ltdrdata/ComfyUI-Manager `model-list.json`. Refreshed on
   * boot (best-effort) so catalog seeding tolerates upstream outages.
   */
  modelListCachePath: path.join(STUDIO_CONFIG_ROOT, 'model-list.cache.json'),
  configFile: env.STUDIO_CONFIG_FILE ?? path.join(STUDIO_CONFIG_ROOT, 'config.json'),
  exposedWidgetsDir: env.STUDIO_EXPOSED_WIDGETS_DIR
    ?? path.join(STUDIO_CONFIG_ROOT, 'exposed_widgets'),
  /** Absolute root of ComfyUI's model tree on disk. May be empty - stat-fallback disabled. */
  modelsDir: env.MODELS_DIR,
  /**
   * Directory holding bundled READ-ONLY seeds (all_nodes.mirrored.json,
   * model-list.json). Do NOT write here — use the named runtime-state paths
   * below for mutable JSON.
   */
  dataDir: env.DATA_DIR || BUNDLED_DATA_DIR,
  /** Bundled plugin-catalog snapshot (tracked, read-only). */
  nodeListPath: env.NODE_LIST_PATH || path.join(BUNDLED_DATA_DIR, 'all_nodes.mirrored.json'),
  /** Mutable plugin cache written by the plugin service (runtime). */
  modelCachePath: env.MODEL_CACHE_PATH || path.join(RUNTIME_STATE_DIR, 'model-cache.json'),
  /** Mutable plugin history written by the plugin service (runtime). */
  pluginHistoryPath: env.PLUGIN_HISTORY_PATH
    || path.join(RUNTIME_STATE_DIR, 'plugin-history.json'),
  /** pip config file consumed by the python service. */
  pipConfigPath: path.join(STUDIO_CONFIG_ROOT, 'pip.conf'),
  /**
   * Launcher system-settings (HF endpoint / GitHub proxy / pip source) persistence.
   * DATA_DIR override preserved for back-compat with existing deployments.
   */
  envConfigFile: env.DATA_DIR
    ? path.join(env.DATA_DIR, 'env-config.json')
    : path.join(RUNTIME_STATE_DIR, 'env-config.json'),
  /**
   * Per-run network check log directory.
   * DATA_DIR override preserved for back-compat with existing deployments.
   */
  networkCheckDir: env.DATA_DIR
    ? path.join(env.DATA_DIR, 'network-checks')
    : path.join(RUNTIME_STATE_DIR, 'network-checks'),
  /** Directory for ComfyUI reset-operation log files. */
  resetLogsDir: path.join(RUNTIME_STATE_DIR, 'reset-logs'),
  /** Temp spool for in-flight multipart uploads (multer diskStorage writes
   *  here; files are deleted in the request handler's finally block).
   *  Sits under the runtime state dir so it shares the same persistent
   *  volume as the DB — avoids /tmp tmpfs limits on some k8s setups. */
  uploadsTmpDir: path.join(RUNTIME_STATE_DIR, 'uploads'),
  /** Mutable download history written by the downloadController (runtime). */
  downloadHistoryPath: path.join(RUNTIME_STATE_DIR, 'download-history.json'),
  /** Mutable ComfyUI launch-options config (runtime). */
  launchOptionsPath: path.join(RUNTIME_STATE_DIR, 'comfyui-launch-options.json'),
  /**
   * User-imported workflow templates. Each file is a TemplateData JSON blob
   * whose `workflow` key holds the LiteGraph document from civitai (or
   * another user source). Merged into the live template cache so the Studio
   * treats them identically to upstream ComfyUI templates.
   */
  userTemplatesDir: path.join(STUDIO_CONFIG_ROOT, 'user-workflows'),
  /**
   * User-writable personality directory. Houses user-authored soul files
   * (souls/*.md) and memory.md. These overlay the bundled seeds in
   * `bundledPersonalitiesDir`; user files always win on name collision.
   * Persists across image rebuilds alongside other user config.
   */
  personalitiesDir: path.join(STUDIO_CONFIG_ROOT, 'personalities'),
  /**
   * Pending soul edit proposals from the studio_propose_soul_edit MCP tool.
   * Each file is a <id>.json blob the user reviews and accepts/rejects via
   * the personality API. Never applied without explicit user confirmation.
   */
  pendingSoulEditsDir: path.join(STUDIO_CONFIG_ROOT, 'personalities', 'pending-soul-edits'),
  /**
   * Timestamped soul file backups created before applying a pending edit.
   * Allows rollback if the user decides the applied change was wrong.
   */
  soulBackupsDir: path.join(STUDIO_CONFIG_ROOT, 'personalities', 'soul-backups'),
  /**
   * Bundled read-only personality seeds shipped with the image. Contains
   * default.md and security-auditor.md souls, and an empty memory.md stub.
   * Services must never write here; use `personalitiesDir` for mutations.
   */
  bundledPersonalitiesDir: path.join(BUNDLED_DATA_DIR, 'personalities'),
  /**
   * Bundled read-only skill seeds. Each skill is a folder containing SKILL.md
   * and optional scripts/. Services must never write here.
   */
  bundledSkillsDir: path.join(BUNDLED_DATA_DIR, 'skills'),
  /**
   * Bundled read-only command seeds. Each command is a single <name>.md file.
   * Services must never write here.
   */
  bundledCommandsDir: path.join(BUNDLED_DATA_DIR, 'commands'),
  /**
   * Single sqlite database file backing the gallery + plugin catalog queries.
   * Overridable via `STUDIO_SQLITE_PATH` so tests can point it at a tmpdir
   * and swap the file on every test case. Resolved lazily via the getter
   * below so per-test env mutations take effect without re-importing.
   */
  get sqlitePath(): string {
    const override = currentSqliteOverride();
    return (override && override.length > 0)
      ? override
      : path.join(RUNTIME_STATE_DIR, 'studio.db');
  },
} as const;

export type Paths = typeof paths;
