// Barrel module for the resumable download library.
//
// Consumers should import from this file, never reach into the
// sub-modules directly:
//
//   import { downloadFile, createDownloadProgress } from '../../lib/download/index.js';
//
// The engine delegates response-side handling to `stream.ts` and HTTP header
// parsing to `httpRanges.ts`. Callers that need low-level helpers (e.g. for
// tests) can import `./httpRanges.js` explicitly.

export { downloadFile } from './engine.js';
export {
  createDownloadProgress,
  calculateSpeed,
  formatFileSize,
} from './progress.js';
export {
  isRedirectStatus,
  resolveRedirectUrl,
  parseContentLength,
  parseContentRangeTotal,
} from './httpRanges.js';
