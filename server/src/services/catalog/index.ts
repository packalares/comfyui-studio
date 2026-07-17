// Public re-exports from the catalog/ folder.

export type { CatalogModel, MergedModel, FileStatus } from './service.js';
export {
  seedFromComfyUI,
  markInstalled,
  markDownloadFailed,
  getAllModels,
  getModel,
  getModelByPair,
  upsertModel,
  isSizeStale,
  refreshSize,
  getMergedModels,
  refreshMany,
  wireCatalogEventHandlers,
  rewireForTests,
  bustScanCache,
  SCAN_CACHE_TTL_MS,
} from './service.js';

export { load, persist, persistCurrent } from './store.js';

export {
  detectUrlHost,
  sortUrlSources,
  mergeUrlSources,
  urlSourceFor,
  declaredByFor,
  mergeIntoExisting,
} from './urlSources.js';
