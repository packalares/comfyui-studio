// CivitaiModelSource.searchByHash tests — isolated so vi.mock is top-level.

import { describe, it, expect, vi } from 'vitest';

// Top-level mocks — hoisted before any imports.
vi.mock('../../src/lib/http.js', () => ({
  fetchWithRetry: vi.fn(),
  getHostAuthHeaders: () => ({}),
  getHfAuthHeaders: () => ({}),
  getCivitaiAuthHeaders: () => ({}),
  getGithubAuthHeaders: () => ({}),
}));

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      CIVITAI_API_BASE: 'https://civitai.com/api/v1',
      CIVITAI_MAX_RESPONSE_BYTES: 10 * 1024 * 1024,
      COMFYUI_PATH: '/tmp/fake-comfy',
    },
  };
});

vi.mock('../../src/services/settings/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/settings/index.js')>();
  return { ...actual, getCivitaiToken: () => undefined };
});

// Imports AFTER mocks.
import { fetchWithRetry } from '../../src/lib/http.js';
import { CivitaiModelSource } from '../../src/services/models/enrichment/CivitaiModelSource.js';

const SHA = 'a'.repeat(64);

describe('CivitaiModelSource.searchByHash', () => {
  const source = new CivitaiModelSource();

  it('calls the correct URL', async () => {
    const mockFetch = vi.mocked(fetchWithRetry);
    const fakeVersion = {
      id: 42,
      modelId: 7,
      trainedWords: ['hero', 'warrior'],
      baseModel: 'SDXL',
      images: [{ url: 'https://img.civitai.com/x.jpg', nsfwLevel: 1 }],
      model: { id: 7, name: 'My Model', tags: ['portrait'], nsfwLevel: 1 },
    };
    mockFetch.mockResolvedValueOnce({ status: 200, headers: {}, text: JSON.stringify(fakeVersion) });
    const result = await source.searchByHash(SHA);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/model-versions/by-hash/${SHA}`),
      expect.any(Object),
    );
    expect(result).not.toBeNull();
    expect(result?.civitai_version_id).toBe(42);
    expect(result?.trigger_words).toEqual(['hero', 'warrior']);
    expect(result?.metadata_source).toBe('civitai');
    expect(result?.tags).toEqual(['portrait']);
    expect(result?.nsfw_level).toBe(1);
  });

  it('returns null on 404', async () => {
    vi.mocked(fetchWithRetry).mockRejectedValueOnce(new Error('404 Not Found'));
    const result = await source.searchByHash(SHA);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.mocked(fetchWithRetry).mockRejectedValueOnce(new Error('network timeout'));
    const result = await source.searchByHash(SHA);
    expect(result).toBeNull();
  });

  it('parses preview URL from first image', async () => {
    const mockFetch = vi.mocked(fetchWithRetry);
    const fakeVersion = {
      id: 1,
      modelId: 2,
      trainedWords: [],
      images: [
        { url: 'https://img.civitai.com/preview.jpg', nsfwLevel: 0 },
        { url: 'https://img.civitai.com/second.jpg', nsfwLevel: 0 },
      ],
      model: {},
    };
    mockFetch.mockResolvedValueOnce({ status: 200, headers: {}, text: JSON.stringify(fakeVersion) });
    const result = await source.searchByHash(SHA);
    expect(result?.preview_remote_url).toBe('https://img.civitai.com/preview.jpg');
  });
});
