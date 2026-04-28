// Integration tests for `installFromCatalog`'s urlSources[]-aware candidate
// build (Wave M Gap 3). Asserts the walker receives the catalog row's
// priority-sorted URL list when present, and falls back to the bundled
// single-URL legacy build otherwise.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedWalk = vi.fn();
vi.mock('../../../src/services/downloadController/walker.js', () => ({
  walkAndDownload: mockedWalk,
}));

const mockedLoad = vi.fn();
vi.mock('../../../src/services/catalogStore.js', () => ({
  load: mockedLoad,
}));

const mockedGetInfo = vi.fn();
vi.mock('../../../src/services/models/info.service.js', () => ({
  getModelInfo: mockedGetInfo,
  getModelList: () => [],
  updateCache: () => undefined,
  convertEssentialModelsToEntries: () => [],
}));

const { installFromCatalog } = await import('../../../src/services/models/models.service.js');
const { __resetForTests: resetProgressTracker } =
  await import('../../../src/services/downloadController/progressTracker.js');

describe('installFromCatalog → walker candidates', () => {
  beforeEach(() => {
    mockedWalk.mockReset();
    mockedLoad.mockReset();
    mockedGetInfo.mockReset();
    resetProgressTracker();
    // walker.then() must succeed for the post-download bus emit not to
    // throw uncaught — we don't await it in the test, so resolved is fine.
    mockedWalk.mockResolvedValue({ url: 'unused' });
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('uses catalog row urlSources[] when present (multi-URL)', async () => {
    mockedGetInfo.mockReturnValue({
      name: 'foo.safetensors', filename: 'foo.safetensors',
      save_path: 'checkpoints', url: 'https://huggingface.co/o/r/resolve/main/foo.safetensors',
    });
    mockedLoad.mockReturnValue({
      models: [{
        filename: 'foo.safetensors',
        urlSources: [
          { url: 'https://huggingface.co/o/r/resolve/main/foo.safetensors', host: 'hf', declaredBy: 'seed' },
          { url: 'https://civitai.com/api/download/models/123', host: 'civitai', declaredBy: 'manual' },
        ],
      }],
    });
    await installFromCatalog('foo.safetensors', 'hf');
    expect(mockedWalk).toHaveBeenCalledTimes(1);
    const opts = mockedWalk.mock.calls[0][0];
    expect(opts.candidates).toHaveLength(2);
    expect(opts.candidates[0].host).toBe('hf');
    expect(opts.candidates[1].host).toBe('civitai');
  });

  it('falls back to single bundled URL when catalog row has no urlSources', async () => {
    mockedGetInfo.mockReturnValue({
      name: 'bar.safetensors', filename: 'bar.safetensors',
      save_path: 'loras', url: 'https://huggingface.co/o/r/resolve/main/bar.safetensors',
    });
    mockedLoad.mockReturnValue({ models: [] });
    await installFromCatalog('bar.safetensors', 'hf');
    expect(mockedWalk).toHaveBeenCalledTimes(1);
    const opts = mockedWalk.mock.calls[0][0];
    expect(opts.candidates).toHaveLength(1);
    expect(opts.candidates[0].url).toContain('huggingface.co');
  });
});
