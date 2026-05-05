// Unit tests for the GPU orchestrator. Verifies the three short-circuit
// gates (`unloadGpuOnUse` flag → co-location check → `isModelLoaded` check)
// and the happy-path unload via `/api/generate` with `keep_alive: 0`.
//
// Mocks in this file:
//   - `services/settings.js` → `getOllamaUrl()` returns a per-test value.
//   - `services/comfyui.js` → `getComfyUIUrl()` returns a per-test value.
//   - `services/chat/ollamaPs.js` → `isModelLoaded()` returns a per-test value.
//   - global `fetch` for the unload POST.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

let ollamaUrl = 'http://localhost:11434';
let comfyUrl = 'http://localhost:8188';
let modelLoadedReturn: boolean | null = true;

vi.mock('../../../src/services/settings.js', () => ({
  getOllamaUrl: () => ollamaUrl,
}));
vi.mock('../../../src/services/comfyui.js', () => ({
  getComfyUIUrl: () => comfyUrl,
}));
vi.mock('../../../src/services/chat/ollamaPs.js', () => ({
  isModelLoaded: vi.fn(async () => modelLoadedReturn),
}));

const orchestrator = await import('../../../src/services/chat/gpuOrchestrator.js');
const { isLikelyColocated, beforeTool } = orchestrator;

import type { StudioTool } from '../../../src/services/chat/tools/defineTool.js';

function makeTool(unloadGpuOnUse: boolean): StudioTool {
  return {
    // The AI-SDK Tool shape isn't reached by the orchestrator — only
    // `unloadGpuOnUse` is read. Cast keeps the type checker happy without
    // pulling in the full AI-SDK type machinery.
    tool: {} as StudioTool['tool'],
    unloadGpuOnUse,
  };
}

describe('isLikelyColocated', () => {
  beforeEach(() => {
    ollamaUrl = 'http://localhost:11434';
    comfyUrl = 'http://localhost:8188';
  });

  it('returns true when hostnames match', () => {
    ollamaUrl = 'http://gpu-node.local:11434';
    comfyUrl = 'http://gpu-node.local:8188';
    expect(isLikelyColocated()).toBe(true);
  });

  it('returns true when both URLs are loopback (mixed forms)', () => {
    ollamaUrl = 'http://localhost:11434';
    comfyUrl = 'http://127.0.0.1:8188';
    expect(isLikelyColocated()).toBe(true);
  });

  it('returns false when hostnames differ and neither is loopback', () => {
    ollamaUrl = 'http://gpu-a.example:11434';
    comfyUrl = 'http://gpu-b.example:8188';
    expect(isLikelyColocated()).toBe(false);
  });

  it('returns true (conservative) when a URL is malformed', () => {
    ollamaUrl = 'not a url';
    comfyUrl = 'http://localhost:8188';
    expect(isLikelyColocated()).toBe(true);
  });
});

describe('beforeTool', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    ollamaUrl = 'http://localhost:11434';
    comfyUrl = 'http://localhost:8188';
    modelLoadedReturn = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  });
  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
    vi.restoreAllMocks();
  });

  it('short-circuits when unloadGpuOnUse=false (no fetch issued)', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const emit = vi.fn();
    await beforeTool(makeTool(false), 'llama3', { emitStatus: emit });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('short-circuits when not co-located', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    ollamaUrl = 'http://gpu-a.example:11434';
    comfyUrl = 'http://gpu-b.example:8188';
    const emit = vi.fn();
    await beforeTool(makeTool(true), 'llama3', { emitStatus: emit });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('short-circuits when isModelLoaded returns false', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    modelLoadedReturn = false;
    const emit = vi.fn();
    await beforeTool(makeTool(true), 'llama3', { emitStatus: emit });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits freeing_gpu and unloads via keep_alive: 0 when all gates pass', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    modelLoadedReturn = true;
    const emit = vi.fn();
    await beforeTool(makeTool(true), 'llama3', { emitStatus: emit });
    expect(emit).toHaveBeenCalledWith('freeing_gpu', expect.any(String));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/generate');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('llama3');
    expect(body.prompt).toBe('');
    expect(body.keep_alive).toBe(0);
  });

  it('does not throw when the unload fetch fails', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const emit = vi.fn();
    await expect(
      beforeTool(makeTool(true), 'llama3', { emitStatus: emit }),
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith('freeing_gpu', expect.any(String));
  });
});
