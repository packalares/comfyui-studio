export {
  setDownloadBroadcaster,
  getAllDownloads,
  findByIdentity,
  trackDownload,
  stopTracking,
  isAtCapacity,
  findQueuedByIdentity,
  enqueueDownload,
} from './facade.js';
export type { DownloadState, DownloadIdentity } from './facade.js';

export {
  createDownloadTask,
  getTaskProgress,
  updateTaskProgress,
  cancelTask,
  downloadModelByName,
  setProgressListener,
  setModelMapping,
  getModelTaskId,
  clearModelMapping,
  removeModelMappingByTaskId,
  createTask,
  getTask,
  hasTask,
  updateTask,
  deleteTask,
  abortTask,
  snapshot,
  __resetForTests,
} from './controller.js';
export type { ProgressListener, TaskId } from './controller.js';

export {
  walkAndDownload,
  classifyWalkerError,
} from './walker.js';
export type { WalkerOptions, WalkerTokens, ClassifiedError, WalkerErrorCode } from './walker.js';

export {
  listHistory,
  addHistoryItem,
  updateHistoryItem,
  deleteHistoryItem,
  clearHistory,
  findHistoryByTaskId,
} from './history.js';
export type { DownloadHistoryItem } from './history.js';
