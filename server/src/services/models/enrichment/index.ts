// Barrel exports for the enrichment module.
export type {
  ModelType, BaseModelMeta, LoraExtra, CheckpointExtra, EmbeddingExtra,
  ModelSource, ModelSourceResult, CatalogEnrichment, UrlSourceVerdict,
} from './types.js';
export { sidecarPath, sidecarExists, readSidecar, writeSidecar } from './sidecar.js';
export { computeSha256, startHashQueue, isHashQueueRunning } from './hashCompute.js';
export { CivitaiModelSource, civitaiSource } from './CivitaiModelSource.js';
export { enrichOne } from './enrich.js';
export type { EnrichOneInput } from './enrich.js';
export {
  previewPathFor, hasLocalPreview, downloadPreviewFor,
} from './previewDownload.js';
export type { PreviewDownloadResult } from './previewDownload.js';
export { registerPreviewHook } from './previewHook.js';
export { verifyUrlSources } from './verifyUrls.js';
export type { UrlSourceVerdict as VerifyUrlSourceVerdict } from './verifyUrls.js';
