// Tests for the model-list cache cascade.
//
// Coverage:
//   - cascadeRead returns the cache file when present.
//   - cascadeRead falls back to the bundled file when cache is absent.
//   - cascadeRead returns an empty list when both are missing.
//   - refreshModelListCache writes the cache atomically and tolerates
//     network failures without throwing or stomping the existing cache.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-modellist-'));
const CACHE_PATH = path.join(TMP, 'cache.json');
const BUNDLED_DIR = path.join(TMP, 'bundled');
fs.mkdirSync(BUNDLED_DIR);

vi.mock('../../../src/config/paths.js', async (orig) => {
  const actual = (await orig()) as { paths: Record<string, unknown> };
  return {
    paths: {
      ...actual.paths,
      modelListCachePath: CACHE_PATH,
      dataDir: BUNDLED_DIR,
    },
  };
});

const cache = await import('../../../src/services/models/modelListCache.js');

function writeFile(p: string, body: unknown): void {
  fs.writeFileSync(p, JSON.stringify(body), 'utf8');
}

describe('modelListCache.cascadeRead', () => {
  beforeEach(() => {
    try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(BUNDLED_DIR, 'model-list.json')); } catch { /* ignore */ }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the cache when it exists', () => {
    writeFile(CACHE_PATH, { models: [{ filename: 'a.bin' }] });
    writeFile(path.join(BUNDLED_DIR, 'model-list.json'), { models: [{ filename: 'b.bin' }] });
    const out = cache.cascadeRead();
    expect(out.models?.[0].filename).toBe('a.bin');
  });

  it('falls back to the bundled file when cache is missing', () => {
    writeFile(path.join(BUNDLED_DIR, 'model-list.json'), { models: [{ filename: 'b.bin' }] });
    const out = cache.cascadeRead();
    expect(out.models?.[0].filename).toBe('b.bin');
  });

  it('returns an empty list when both are missing', () => {
    const out = cache.cascadeRead();
    expect(out.models).toEqual([]);
  });
});

describe('modelListCache.refreshModelListCache', () => {
  beforeEach(() => {
    try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes the cache when upstream returns 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ filename: 'fresh.bin' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    await cache.refreshModelListCache({ force: true });
    const written = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    expect(written.models?.[0].filename).toBe('fresh.bin');
  });

  it('tolerates a network failure: leaves prior cache in place', async () => {
    writeFile(CACHE_PATH, { models: [{ filename: 'old.bin' }] });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENETUNREACH'));
    await cache.refreshModelListCache({ force: true });
    const after = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    expect(after.models?.[0].filename).toBe('old.bin');
  });

  it('tolerates an upstream non-2xx: leaves prior cache in place', async () => {
    writeFile(CACHE_PATH, { models: [{ filename: 'old.bin' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    await cache.refreshModelListCache({ force: true });
    const after = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    expect(after.models?.[0].filename).toBe('old.bin');
  });
});
