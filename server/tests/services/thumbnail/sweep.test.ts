// Sweep logic: expired entries get unlinked, total-bytes over cap triggers
// LRU trim. We write real files with forged mtimes instead of mocking fs —
// simpler and the walk runs fast on a temp dir.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('thumbnail cache sweep', () => {
  let tmpRoot: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-sweep-test-'));
    saved = {
      COMFYUI_PATH: process.env.COMFYUI_PATH,
      THUMB_CACHE_MAX_AGE_DAYS: process.env.THUMB_CACHE_MAX_AGE_DAYS,
      THUMB_CACHE_MAX_BYTES: process.env.THUMB_CACHE_MAX_BYTES,
    };
    process.env.COMFYUI_PATH = tmpRoot;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeFileWithMtime(filePath: string, bytes: Buffer, mtimeMs: number): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }

  it('deletes entries older than THUMB_CACHE_MAX_AGE_DAYS', async () => {
    process.env.THUMB_CACHE_MAX_AGE_DAYS = '1';
    process.env.THUMB_CACHE_MAX_BYTES = String(10 * 1024 * 1024);
    vi.resetModules();
    const { runSweep } = await import('../../../src/services/thumbnail/sweep.js');
    const { cacheRoot } = await import('../../../src/services/thumbnail/cache.js');
    const root = cacheRoot();

    const now = Date.now();
    const old = now - 2 * 86_400_000;
    const fresh = now - 30_000;
    writeFileWithMtime(path.join(root, 'aa', 'old1.webp'), Buffer.alloc(100, 1), old);
    writeFileWithMtime(path.join(root, 'bb', 'fresh1.webp'), Buffer.alloc(100, 2), fresh);

    const result = await runSweep();
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(path.join(root, 'aa', 'old1.webp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'bb', 'fresh1.webp'))).toBe(true);
  });

  it('LRU-trims oldest-first when total bytes exceed the cap', async () => {
    process.env.THUMB_CACHE_MAX_AGE_DAYS = '365';
    process.env.THUMB_CACHE_MAX_BYTES = '250';
    vi.resetModules();
    const { runSweep } = await import('../../../src/services/thumbnail/sweep.js');
    const { cacheRoot } = await import('../../../src/services/thumbnail/cache.js');
    const root = cacheRoot();

    const now = Date.now();
    writeFileWithMtime(path.join(root, 'aa', 'oldest.webp'), Buffer.alloc(100, 1), now - 4000);
    writeFileWithMtime(path.join(root, 'bb', 'middle.webp'), Buffer.alloc(100, 2), now - 2000);
    writeFileWithMtime(path.join(root, 'cc', 'newest.webp'), Buffer.alloc(100, 3), now - 1000);

    const result = await runSweep();
    expect(result.totalBytes).toBeLessThanOrEqual(250);
    // Oldest file unlinked first.
    expect(fs.existsSync(path.join(root, 'aa', 'oldest.webp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'cc', 'newest.webp'))).toBe(true);
  });

  it('collectStats reports bucketCount, totalBytes, oldestMtimeMs', async () => {
    const { collectStats } = await import('../../../src/services/thumbnail/sweep.js');
    const { cacheRoot } = await import('../../../src/services/thumbnail/cache.js');
    const root = cacheRoot();

    const now = Date.now();
    writeFileWithMtime(path.join(root, 'aa', 'x.webp'), Buffer.alloc(50, 1), now - 5000);
    writeFileWithMtime(path.join(root, 'bb', 'y.webp'), Buffer.alloc(30, 2), now - 100);

    const stats = await collectStats();
    expect(stats.count).toBe(2);
    expect(stats.totalBytes).toBe(80);
    expect(stats.bucketCount).toBe(2);
    expect(stats.oldestMtimeMs).not.toBeNull();
    expect(stats.oldestMtimeMs!).toBeLessThan(now - 1000);
  });
});
