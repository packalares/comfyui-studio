// Tests for the URL walker + walker-side error classifier.
//
// The walker's job is to HEAD-probe each candidate URL in priority order;
// stream the first one that returns a 2xx; classify cross-URL failures so
// AUTH_REQUIRED stops the walk while URL_BROKEN / TRANSIENT fall through.
//
// We mock both `globalThis.fetch` (for HEAD probes) and
// `downloadModelByName` (the streaming path), so the walker can be exercised
// without touching the disk or the HTTP engine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockedDownload = vi.fn();
vi.mock('../../../src/services/downloadController/downloadController.service.js', () => ({
  downloadModelByName: mockedDownload,
}));

const { walkAndDownload, classifyWalkerError } =
  await import('../../../src/services/downloadController/walker.js');

import type { UrlSource } from '../../../src/contracts/catalog.contract.js';

function urlSource(url: string, host: UrlSource['host']): UrlSource {
  return { url, host, declaredBy: 'seed' };
}

describe('classifyWalkerError', () => {
  it('codes HTTP 401 / 403 as AUTH_REQUIRED', () => {
    expect(classifyWalkerError(new Error('HTTP 401')).code).toBe('AUTH_REQUIRED');
    expect(classifyWalkerError(new Error('HTTP 403')).code).toBe('AUTH_REQUIRED');
  });

  it('codes HTTP 404 / 500 as URL_BROKEN', () => {
    expect(classifyWalkerError(new Error('HTTP 404')).code).toBe('URL_BROKEN');
    expect(classifyWalkerError(new Error('HTTP 502')).code).toBe('URL_BROKEN');
  });

  it('codes everything else as TRANSIENT', () => {
    expect(classifyWalkerError(new Error('aborted')).code).toBe('TRANSIENT');
    expect(classifyWalkerError(new Error('socket timeout')).code).toBe('TRANSIENT');
  });
});

describe('walkAndDownload', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedDownload.mockReset();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the first URL whose HEAD succeeds and stream resolves', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    mockedDownload.mockResolvedValueOnce(undefined);
    const out = await walkAndDownload({
      modelName: 'a.bin',
      outputPath: '/tmp/a.bin',
      taskId: 'task-1',
      candidates: [urlSource('https://huggingface.co/a', 'hf')],
      tokens: {},
    });
    expect(out.url).toBe('https://huggingface.co/a');
    expect(fetchSpy).toHaveBeenCalled();
    expect(mockedDownload).toHaveBeenCalledTimes(1);
  });

  it('falls through to next URL on 404 HEAD', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    mockedDownload.mockResolvedValueOnce(undefined);
    const out = await walkAndDownload({
      modelName: 'a.bin',
      outputPath: '/tmp/a.bin',
      taskId: 'task-2',
      candidates: [
        urlSource('https://huggingface.co/missing', 'hf'),
        urlSource('https://civitai.com/api/download/models/1', 'civitai'),
      ],
      tokens: {},
    });
    expect(out.url).toBe('https://civitai.com/api/download/models/1');
    expect(calls).toBe(2);
  });

  it('stops the walk on AUTH_REQUIRED HEAD without trying further URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 403 }),
    );
    await expect(walkAndDownload({
      modelName: 'a.bin',
      outputPath: '/tmp/a.bin',
      taskId: 'task-3',
      candidates: [
        urlSource('https://huggingface.co/gated', 'hf'),
        urlSource('https://civitai.com/api/download/models/1', 'civitai'),
      ],
      tokens: {},
    })).rejects.toThrow(/HTTP 403/);
    // Only the first URL was probed; the walker stopped.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockedDownload).not.toHaveBeenCalled();
  });

  it('falls through to next URL when the engine throws HTTP 404 mid-stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    mockedDownload
      .mockRejectedValueOnce(new Error('HTTP 404'))
      .mockResolvedValueOnce(undefined);
    const out = await walkAndDownload({
      modelName: 'a.bin',
      outputPath: '/tmp/a.bin',
      taskId: 'task-4',
      candidates: [
        urlSource('https://huggingface.co/dead', 'hf'),
        urlSource('https://civitai.com/api/download/models/1', 'civitai'),
      ],
      tokens: {},
    });
    expect(out.url).toBe('https://civitai.com/api/download/models/1');
    expect(mockedDownload).toHaveBeenCalledTimes(2);
  });

  it('aggregate-error message lists every failed URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    await expect(walkAndDownload({
      modelName: 'a.bin',
      outputPath: '/tmp/a.bin',
      taskId: 'task-5',
      candidates: [
        urlSource('https://huggingface.co/gone-1', 'hf'),
        urlSource('https://civitai.com/gone-2', 'civitai'),
      ],
      tokens: {},
    })).rejects.toThrow(/All 2 download URL\(s\) failed/);
  });

  it('throws when the candidate list is empty', async () => {
    await expect(walkAndDownload({
      modelName: 'a.bin',
      outputPath: '/tmp/a.bin',
      taskId: 'task-6',
      candidates: [],
      tokens: {},
    })).rejects.toThrow(/No download candidates/);
  });

  // Wave M Gap 3: the catalog row's full `urlSources[]` is now passed
  // to the walker, exercising the multi-URL fallback in production.
  it('multi-URL fallback: first 404 → second 200 → success', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    mockedDownload.mockResolvedValueOnce(undefined);
    const out = await walkAndDownload({
      modelName: 'multi.bin',
      outputPath: '/tmp/multi.bin',
      taskId: 'task-multi-1',
      candidates: [
        urlSource('https://huggingface.co/dead', 'hf'),
        urlSource('https://civitai.com/api/download/models/2', 'civitai'),
      ],
      tokens: {},
    });
    expect(out.url).toBe('https://civitai.com/api/download/models/2');
    expect(calls).toBe(2);
    expect(mockedDownload).toHaveBeenCalledTimes(1);
  });

  it('multi-URL stop-on-auth: first URL 401 halts the walker (gated, not bad)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    await expect(walkAndDownload({
      modelName: 'gated.bin',
      outputPath: '/tmp/gated.bin',
      taskId: 'task-multi-2',
      candidates: [
        urlSource('https://huggingface.co/gated', 'hf'),
        urlSource('https://civitai.com/api/download/models/1', 'civitai'),
      ],
      tokens: {},
    })).rejects.toThrow(/HTTP 401/);
    // Walker stops at the first URL — auth is terminal because a token
    // missing on the user's side won't materialize on a different mirror.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockedDownload).not.toHaveBeenCalled();
  });
});
