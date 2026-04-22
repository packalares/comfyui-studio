// Cache layout: bucketing puts files under `<aa>/<md5>.webp`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('thumbnail cache layout', () => {
  let tmpRoot: string;
  let saved: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-cache-test-'));
    saved = process.env.COMFYUI_PATH;
    process.env.COMFYUI_PATH = tmpRoot;
  });

  afterEach(() => {
    if (saved !== undefined) process.env.COMFYUI_PATH = saved;
    else delete process.env.COMFYUI_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('places cached webps under a two-char bucket dir', async () => {
    const { cachePathForKey } = await import('../../../src/services/thumbnail/cache.js');
    const { filePath, bucketDir } = cachePathForKey('aabbccddeeff00112233445566778899');
    expect(path.basename(bucketDir)).toBe('aa');
    expect(filePath.endsWith(path.join('aa', 'aabbccddeeff00112233445566778899.webp'))).toBe(true);
    // bucket dir was created as a side-effect of cachePathForKey
    expect(fs.existsSync(bucketDir)).toBe(true);
  });

  it('peekCached returns null on miss and the path on hit with bytes', async () => {
    const cache = await import('../../../src/services/thumbnail/cache.js');
    const { filePath } = cache.cachePathForKey('00bbccddeeff00112233445566778899');
    expect(cache.peekCached('00bbccddeeff00112233445566778899')).toBeNull();
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3]));
    expect(cache.peekCached('00bbccddeeff00112233445566778899')).toBe(filePath);
  });

  it('remoteUrlKey + localFileKey produce stable 32-char md5 hex', async () => {
    const cache = await import('../../../src/services/thumbnail/cache.js');
    const k1 = cache.remoteUrlKey('https://civitai.com/a.png', 320);
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
    const tmp = path.join(tmpRoot, 'source.bin');
    fs.writeFileSync(tmp, Buffer.from([0]));
    const k2 = cache.localFileKey(tmp, 320);
    expect(k2).toMatch(/^[0-9a-f]{32}$/);
    // Width change produces a different key.
    expect(cache.localFileKey(tmp, 320)).not.toBe(cache.localFileKey(tmp, 640));
  });
});
