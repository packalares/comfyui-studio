// Tests for the image proxy + md5 disk cache service.
//
// The service reads its cache dir from env.COMFYUI_PATH, which is frozen at
// env.ts import time. We reset modules before each test and point
// COMFYUI_PATH at a fresh mkdtemp directory so tests stay hermetic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

async function tinyPng(): Promise<Buffer> {
  // 4x4 solid-red PNG produced by sharp itself — guaranteed decodable.
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  }).png().toBuffer();
}

function pngResponse(body: Buffer): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(body.byteLength) },
  });
}

describe('proxyImage', () => {
  let tmpRoot: string;
  let savedComfyPath: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgproxy-test-'));
    savedComfyPath = process.env.COMFYUI_PATH;
    process.env.COMFYUI_PATH = tmpRoot;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedComfyPath !== undefined) process.env.COMFYUI_PATH = savedComfyPath;
    else delete process.env.COMFYUI_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('throws HOST_NOT_ALLOWED for off-list hosts', async () => {
    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    await expect(proxyImage({ url: 'https://evil.com/x.png', width: 128 }))
      .rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
  });

  it('throws HOST_NOT_ALLOWED for non-URL input', async () => {
    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    await expect(proxyImage({ url: 'not a url', width: 128 }))
      .rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' });
  });

  it('throws INVALID_WIDTH for width=0', async () => {
    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    await expect(proxyImage({ url: 'https://civitai.com/a.png', width: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_WIDTH' });
  });

  it('throws INVALID_WIDTH for width=5000', async () => {
    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    await expect(proxyImage({ url: 'https://civitai.com/a.png', width: 5000 }))
      .rejects.toMatchObject({ code: 'INVALID_WIDTH' });
  });

  it('cache miss -> fetches origin, writes file, cached=false', async () => {
    const png = await tinyPng();
    let fetchCount = 0;
    globalThis.fetch = (async () => { fetchCount++; return pngResponse(png); }) as typeof fetch;

    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    const out = await proxyImage({ url: 'https://civitai.com/foo.png', width: 64 });
    expect(out.cached).toBe(false);
    expect(out.contentType).toBe('image/webp');
    expect(fs.existsSync(out.filePath)).toBe(true);
    expect(fs.statSync(out.filePath).size).toBeGreaterThan(0);
    expect(fetchCount).toBe(1);
  });

  it('cache hit on second call -> no fetch, cached=true', async () => {
    const png = await tinyPng();
    let fetchCount = 0;
    globalThis.fetch = (async () => { fetchCount++; return pngResponse(png); }) as typeof fetch;

    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    const first = await proxyImage({ url: 'https://civitai.com/foo.png', width: 64 });
    expect(first.cached).toBe(false);
    expect(fetchCount).toBe(1);

    const second = await proxyImage({ url: 'https://civitai.com/foo.png', width: 64 });
    expect(second.cached).toBe(true);
    expect(second.filePath).toBe(first.filePath);
    expect(fetchCount).toBe(1);
  });

  it('no .tmp file is left behind after a successful write', async () => {
    const png = await tinyPng();
    globalThis.fetch = (async () => pngResponse(png)) as typeof fetch;

    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    const out = await proxyImage({ url: 'https://civitai.com/foo.png', width: 64 });
    const cacheFolder = path.dirname(out.filePath);
    const leftoverTmp = fs.readdirSync(cacheFolder).filter((n) => n.endsWith('.tmp'));
    expect(leftoverTmp).toEqual([]);
  });

  it('UPSTREAM_FAILED when origin returns 404', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;

    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    await expect(proxyImage({ url: 'https://civitai.com/missing.png', width: 64 }))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILED', status: 404 });
  });

  it('subdomain allowance via leading-dot suffix match', async () => {
    const png = await tinyPng();
    globalThis.fetch = (async () => pngResponse(png)) as typeof fetch;

    const { proxyImage } = await import('../../src/services/imgProxy/imgProxy.service.js');
    const out = await proxyImage({ url: 'https://image.civitai.com/abc/foo.png', width: 64 });
    expect(out.cached).toBe(false);
    expect(fs.existsSync(out.filePath)).toBe(true);
  });
});
