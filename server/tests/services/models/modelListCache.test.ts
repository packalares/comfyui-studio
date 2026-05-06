// Tests for the model-list cache.
//
// Coverage:
//   - getCachedModelList returns the cache file when present.
//   - getCachedModelList returns an empty list when the cache is missing.
//   - ensureModelListCacheSeeded copies bundled -> cache on first boot,
//     stripping `size` from each entry, and is a no-op on subsequent calls.
//   - refreshModelListFromUpstream writes the cache (strips size), tolerates
//     network failures and non-2xx responses without stomping the prior file.

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

describe('modelListCache.getCachedModelList', () => {
  beforeEach(() => {
    try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(BUNDLED_DIR, 'model-list.json')); } catch { /* ignore */ }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the cache when it exists', () => {
    writeFile(CACHE_PATH, { models: [{ filename: 'a.bin' }] });
    const out = cache.getCachedModelList();
    expect(out.models?.[0].filename).toBe('a.bin');
  });

  it('returns an empty list when the cache is missing', () => {
    const out = cache.getCachedModelList();
    expect(out.models).toEqual([]);
  });
});

describe('modelListCache.ensureModelListCacheSeeded', () => {
  beforeEach(() => {
    try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(BUNDLED_DIR, 'model-list.json')); } catch { /* ignore */ }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('copies the bundled list to the cache on first call, stripping size', async () => {
    writeFile(path.join(BUNDLED_DIR, 'model-list.json'), {
      models: [
        { filename: 'a.bin', size: '19.6GB' },
        { filename: 'b.bin', size: '810MB' },
      ],
    });
    await cache.ensureModelListCacheSeeded();
    const written = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    expect(written.models).toHaveLength(2);
    for (const m of written.models) {
      expect(m).not.toHaveProperty('size');
    }
    expect(written.models[0].filename).toBe('a.bin');
  });

  it('is a no-op when the cache already exists', async () => {
    writeFile(CACHE_PATH, { models: [{ filename: 'preexisting.bin' }] });
    writeFile(path.join(BUNDLED_DIR, 'model-list.json'), {
      models: [{ filename: 'bundled.bin' }],
    });
    await cache.ensureModelListCacheSeeded();
    const after = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    // Cache untouched: still the preexisting entry, not the bundled one.
    expect(after.models[0].filename).toBe('preexisting.bin');
  });

  it('logs and no-ops when the bundled seed is also missing', async () => {
    await cache.ensureModelListCacheSeeded();
    expect(fs.existsSync(CACHE_PATH)).toBe(false);
  });
});

describe('modelListCache.refreshModelListFromUpstream', () => {
  beforeEach(() => {
    try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes the cache and strips size when upstream returns 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        models: [
          { filename: 'fresh.bin', size: '19.6GB' },
          { filename: 'no-size.bin' },
        ],
      }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await cache.refreshModelListFromUpstream();
    expect(result.ok).toBe(true);
    const written = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    expect(written.models).toHaveLength(2);
    for (const m of written.models) {
      expect(m).not.toHaveProperty('size');
    }
  });

  it('tolerates a network failure: leaves prior cache in place', async () => {
    writeFile(CACHE_PATH, { models: [{ filename: 'old.bin' }] });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENETUNREACH'));
    const result = await cache.refreshModelListFromUpstream();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ENETUNREACH');
    const after = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    expect(after.models?.[0].filename).toBe('old.bin');
  });

  it('tolerates an upstream non-2xx: leaves prior cache in place', async () => {
    writeFile(CACHE_PATH, { models: [{ filename: 'old.bin' }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    const result = await cache.refreshModelListFromUpstream();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('500');
    const after = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    expect(after.models?.[0].filename).toBe('old.bin');
  });
});
