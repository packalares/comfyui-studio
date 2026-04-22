// Pexels query builder + in-memory memoization. We don't hit the real API;
// the outbound fetch is mocked and the test validates the query string +
// per-prompt cache hit (single fetch for N calls with the same query). The
// API key is sourced from the persisted settings service (not env) — tests
// point the config file at a temp dir and seed it via setPexelsApiKey.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('thumbnail pexels helper', () => {
  let tmpRoot: string;
  let saved: Record<string, string | undefined>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pexels-test-'));
    saved = {
      COMFYUI_PATH: process.env.COMFYUI_PATH,
      STUDIO_CONFIG_FILE: process.env.STUDIO_CONFIG_FILE,
    };
    process.env.COMFYUI_PATH = tmpRoot;
    process.env.STUDIO_CONFIG_FILE = path.join(tmpRoot, 'config.json');
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('queryFromPrompt trims + caps at 50 chars', async () => {
    const { queryFromPrompt } = await import('../../../src/services/thumbnail/pexels.js');
    expect(queryFromPrompt('')).toBe('');
    expect(queryFromPrompt('  hello   world  ')).toBe('hello world');
    expect(queryFromPrompt('x'.repeat(100)).length).toBe(50);
  });

  it('returns null when no Pexels API key is configured', async () => {
    const { findPexelsImageUrl } = await import('../../../src/services/thumbnail/pexels.js');
    expect(await findPexelsImageUrl('cats')).toBeNull();
  });

  it('memoizes: second call with same query does not re-fetch', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({
        photos: [{ src: { medium: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg' } }],
      }), { status: 200 });
    }) as typeof fetch;

    const settings = await import('../../../src/services/settings.js');
    settings.setPexelsApiKey('test-key');

    const { findPexelsImageUrl, __resetPexelsCacheForTests } =
      await import('../../../src/services/thumbnail/pexels.js');
    __resetPexelsCacheForTests();

    const first = await findPexelsImageUrl('cats');
    const second = await findPexelsImageUrl('cats');
    expect(first).toBe(second);
    expect(callCount).toBe(1);
  });

  it('returns null when Pexels responds with no photos', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ photos: [] }), { status: 200 })
    ) as typeof fetch;

    const settings = await import('../../../src/services/settings.js');
    settings.setPexelsApiKey('test-key');

    const { findPexelsImageUrl, __resetPexelsCacheForTests } =
      await import('../../../src/services/thumbnail/pexels.js');
    __resetPexelsCacheForTests();

    expect(await findPexelsImageUrl('no-hits-query')).toBeNull();
  });
});
