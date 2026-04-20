// Plugin service facade. Route handlers import this file instead of reaching
// into individual service modules. Nothing here touches Express or any
// request/response object — HTTP binding lives in `routes/plugins.routes.ts`.

export * as cache from './cache.service.js';
export * as history from './history.service.js';
export * as progress from './progress.service.js';
export * as install from './install.service.js';
export * as uninstall from './uninstall.service.js';
export * as switchVersion from './switchVersion.service.js';
export * as info from './info.service.js';
export { getPluginsRoot, getPluginPath, ensurePluginDirs } from './locations.js';
