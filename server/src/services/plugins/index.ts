// Public barrel. Route handlers import `* as plugins from './index.js'` and
// access sub-domains as `plugins.cache.X`, `plugins.install.X`, etc. — the
// same namespace shape as the old `plugins.service.ts` barrel.

export * as cache from './cache.js';
export * as history from './history.js';
export * as progress from './history.js';
export * as install from './install.js';
export * as uninstall from './uninstall.js';
export * as switchVersion from './uninstall.js';
export * as info from './info.js';
export { getPluginsRoot, getPluginPath, ensurePluginDirs } from './locations.js';
