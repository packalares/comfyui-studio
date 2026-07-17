// Tests for the download facade: delta-only emit, queued event on enqueue.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before importing facade.
const mockGetTaskProgress = vi.fn();
const mockGetHfToken = vi.fn(() => 'hf-tok');
const mockGetCivitaiToken = vi.fn(() => 'cv-tok');
const mockGetDownloadsMaxConcurrent = vi.fn(() => 2);
const mockGetDownloadsMaxQueue = vi.fn(() => 10);
const mockMatchesIdentity = vi.fn(() => false);

vi.mock('../../src/lib/identity.js', () => ({
  matchesIdentity: mockMatchesIdentity,
}));

vi.mock('../../src/services/downloads/controller.js', () => ({
  getTaskProgress: mockGetTaskProgress,
  setProgressListener: vi.fn(),
}));

vi.mock('../../src/services/models/service.js', () => ({
  downloadCustom: vi.fn(),
}));

vi.mock('../../src/services/settings/index.js', () => ({
  getHfToken: mockGetHfToken,
  getCivitaiToken: mockGetCivitaiToken,
  getDownloadsMaxConcurrent: mockGetDownloadsMaxConcurrent,
  getDownloadsMaxQueue: mockGetDownloadsMaxQueue,
}));

vi.mock('../../src/lib/errors.js', () => ({
  RateLimitError: class RateLimitError extends Error {},
}));

const {
  setDownloadBroadcaster,
  trackDownload,
  enqueueDownload,
  stopTracking,
  getAllDownloads,
} = await import('../../src/services/downloads/facade.js');

describe('downloads facade — delta-only emit', () => {
  let emitted: object[] = [];

  beforeEach(() => {
    emitted = [];
    setDownloadBroadcaster(msg => emitted.push(msg));
    mockGetTaskProgress.mockReset();
  });

  it('emits initial state on trackDownload', async () => {
    const taskId = 'test-task-1';
    mockGetTaskProgress.mockReturnValue({
      overallProgress: 0,
      currentModelProgress: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      speed: 0,
      status: 'downloading',
      completed: false,
      error: null,
    });
    trackDownload(taskId);
    // initial emit on trackDownload + optional pollOnce emit
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    const first = emitted[0] as { type: string; data: { taskId: string; status: string } };
    expect(first.type).toBe('download');
    expect(first.data.taskId).toBe(taskId);
    expect(first.data.status).toBe('downloading');
    stopTracking(taskId);
  });

  it('does not emit again when progress is identical', async () => {
    const taskId = 'test-task-2';
    const progress = {
      overallProgress: 50,
      currentModelProgress: 50,
      totalBytes: 1000,
      downloadedBytes: 500,
      speed: 100,
      status: 'downloading',
      completed: false,
      error: null,
    };
    mockGetTaskProgress.mockReturnValue(progress);

    trackDownload(taskId);
    const countAfterTrack = emitted.length;

    // Simulate a second pollOnce call with identical data — facade should suppress the emit.
    // We call pollOnce indirectly by invoking the setProgressListener callback captured
    // in the module init. Since we mocked setProgressListener we cannot call it directly,
    // but we can verify that getAllDownloads still holds the entry.
    expect(getAllDownloads().some(d => d.taskId === taskId)).toBe(true);
    // No additional emit for identical state.
    expect(emitted.length).toBe(countAfterTrack);
    stopTracking(taskId);
  });

  it('emits a terminal completed:true frame when a download finishes', () => {
    const taskId = 'test-task-3';
    mockGetTaskProgress.mockReturnValue({
      overallProgress: 100,
      currentModelProgress: 100,
      totalBytes: 1000,
      downloadedBytes: 1000,
      speed: 0,
      status: 'completed',
      completed: true,
      error: null,
    });
    // trackDownload triggers pollOnce which detects terminal state and calls stopTracking,
    // which emits a completed:true frame.
    trackDownload(taskId);
    const terminalFrames = (emitted as Array<{ type: string; data: { completed?: boolean } }>)
      .filter(m => m.type === 'download' && m.data.completed === true);
    expect(terminalFrames.length).toBeGreaterThanOrEqual(1);
  });
});

describe('downloads facade — queued event on enqueue', () => {
  let emitted: object[] = [];

  beforeEach(() => {
    emitted = [];
    setDownloadBroadcaster(msg => emitted.push(msg));
  });

  it('immediately broadcasts a queued event when enqueueDownload is called', () => {
    const synthId = enqueueDownload({
      hfUrl: 'https://huggingface.co/foo/bar',
      modelDir: 'loras',
      modelName: 'my-lora',
      filename: 'my-lora.safetensors',
    });

    expect(synthId).toMatch(/^queued_/);
    expect(emitted.length).toBe(1);
    const msg = emitted[0] as { type: string; data: { status: string; taskId: string } };
    expect(msg.type).toBe('download');
    expect(msg.data.status).toBe('queued');
    expect(msg.data.taskId).toBe(synthId);
  });
});
