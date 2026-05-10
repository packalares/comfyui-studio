// Public re-exports for the comfyui service group.
// Callers that previously imported from `services/comfyui.js` (the old sibling)
// can now import from `services/comfyui/index.js` or directly from the
// sub-module that owns the symbol.

export {
  fetchComfyUI,
  ComfyUIHttpError,
  getSystemStats,
  getQueue,
  getQueuePromptIds,
  getHistoryForPrompt,
  deleteHistoryPrompts,
  submitPrompt,
  proxyView,
  getGalleryItems,
  getComfyUIUrl,
  detectMediaType,
  collectNodeOutputFiles,
} from './api.js';
export type { GalleryItem } from './api.js';

export { getProcessService, setProcessService, ProcessService, LogService } from './process.js';
export type { ComfyUILogStore, SpawnContext } from './process.js';

export {
  getLaunchOptions,
  getLaunchCommandView,
  readConfig,
  resetToDefault,
  updateLaunchOptions,
  buildCliArgs,
  buildCliArgsString,
  getDefaultConfig,
} from './launchOptions.js';
export type { LaunchOptionItem, LaunchOptionType, LaunchOptionsConfig, LaunchCommandView } from './launchOptions.js';

export { getStatus, getVersionInfo, getAppVersion, resetVersionCache } from './status.js';
export type { ComfyUIStatus } from './status.js';

export { createComfyUIProxy, startComfyUIProxy } from './proxy.js';

export { isComfyUIRunning, getUptime, getGPUMode } from './utils.js';
