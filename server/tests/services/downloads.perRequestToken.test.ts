// T4: queued downloads use the per-request HF token captured at enqueue time.
//
// Audit F4: tryDequeue was calling downloadCustom with settings.getHfToken()
// (the server-side stored token), discarding the per-request hfToken the user
// supplied in the original POST /models/download-custom body.

import { describe, expect, it, vi } from 'vitest';

const SETTINGS_TOKEN = 'settings-token-stored';
const REQUEST_TOKEN = 'request-token-per-download';

const downloadCustomSpy = vi.hoisted(() => vi.fn().mockResolvedValue({
  taskId: 'task-123', fileName: 'model.safetensors', saveDir: 'models/loras',
}));

vi.mock('../../src/services/models/service.js', () => ({
  downloadCustom: downloadCustomSpy,
  scanAndRefresh: vi.fn().mockResolvedValue([]),
  toWireEntry: vi.fn(m => m),
}));

vi.mock('../../src/services/settings/index.js', () => ({
  getHfToken: vi.fn().mockReturnValue(SETTINGS_TOKEN),
  getCivitaiToken: vi.fn().mockReturnValue(undefined),
  // Large cap so active.size never blocks dequeue in tests.
  getDownloadsMaxConcurrent: vi.fn().mockReturnValue(100),
  getDownloadsMaxQueue: vi.fn().mockReturnValue(100),
}));

vi.mock('../../src/services/downloads/controller.js', () => ({
  getTaskProgress: vi.fn().mockReturnValue(null),
  setProgressListener: vi.fn(),
}));

const facade = await import('../../src/services/downloads/facade.js');

describe('downloads facade — per-request token threading (F4)', () => {
  it('queued item with per-request hfToken passes it to downloadCustom on dequeue', async () => {
    downloadCustomSpy.mockClear();
    downloadCustomSpy.mockResolvedValue({
      taskId: 'task-q1', fileName: 'model.safetensors', saveDir: 'models/loras',
    });

    // With a large concurrency cap and empty active map, enqueueDownload → tryDequeue
    // fires synchronously via kickQueue path. Use kickQueue to trigger dequeue.
    facade.enqueueDownload({
      hfUrl: 'https://huggingface.co/org/repo/resolve/main/model.safetensors',
      modelDir: 'loras',
      filename: 'model.safetensors',
      modelName: 'Test Model',
      hfToken: REQUEST_TOKEN,
    });

    // kickQueue calls tryDequeue which is async — flush microtasks.
    facade.kickQueue();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(downloadCustomSpy).toHaveBeenCalled();
    const [, , tokens] = downloadCustomSpy.mock.calls[downloadCustomSpy.mock.calls.length - 1] as [unknown, unknown, { hfToken?: string }];
    expect(tokens.hfToken).toBe(REQUEST_TOKEN);
    expect(tokens.hfToken).not.toBe(SETTINGS_TOKEN);
  });

  it('queued item without per-request token falls back to settings token', async () => {
    downloadCustomSpy.mockClear();
    downloadCustomSpy.mockResolvedValue({
      taskId: 'task-q2', fileName: 'model2.safetensors', saveDir: 'models/checkpoints',
    });

    facade.enqueueDownload({
      hfUrl: 'https://huggingface.co/org/repo/resolve/main/model2.safetensors',
      modelDir: 'checkpoints',
      filename: 'model2.safetensors',
      modelName: 'Test Model 2',
      // No hfToken supplied.
    });

    facade.kickQueue();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(downloadCustomSpy).toHaveBeenCalled();
    const [, , tokens] = downloadCustomSpy.mock.calls[downloadCustomSpy.mock.calls.length - 1] as [unknown, unknown, { hfToken?: string }];
    expect(tokens.hfToken).toBe(SETTINGS_TOKEN);
  });
});
