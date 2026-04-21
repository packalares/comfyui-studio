// Tests for /api/img route handler — verifies parameter validation,
// upstream-error mapping, and the immutable Cache-Control response header.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  }).png().toBuffer();
}

function pngResponse(body: Buffer): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(body.byteLength) },
  });
}

async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const { default: imgProxyRouter } = await import('../../src/routes/imgProxy.routes.js');
  const app = express();
  app.use(imgProxyRouter);
  return await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('/img route', () => {
  let tmpRoot: string;
  let savedComfyPath: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imgproxy-route-test-'));
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

  // Install a fetch mock that only intercepts external HTTP(S) requests,
  // letting same-origin (127.0.0.1) test-server requests pass through to
  // the real fetch. Otherwise the mock swallows the request/response the
  // test harness uses to talk to its own app.
  function installPassthroughMock(pngBody: Buffer): void {
    const real = originalFetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return real(input as RequestInfo, init);
      }
      return pngResponse(pngBody);
    }) as typeof fetch;
  }

  it('400 when url is missing', async () => {
    const app = await startApp();
    try {
      const res = await originalFetch(`${app.url}/img?w=64`);
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });

  it('400 when w is missing', async () => {
    const app = await startApp();
    try {
      const res = await originalFetch(`${app.url}/img?url=${encodeURIComponent('https://civitai.com/a.png')}`);
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });

  it('400 on disallowed host', async () => {
    const app = await startApp();
    try {
      const res = await originalFetch(`${app.url}/img?url=${encodeURIComponent('https://evil.com/x.png')}&w=64`);
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('HOST_NOT_ALLOWED');
    } finally { await app.close(); }
  });

  it('200 + immutable Cache-Control on a valid civitai-style URL', async () => {
    const png = await tinyPng();
    installPassthroughMock(png);
    const app = await startApp();
    try {
      const target = encodeURIComponent('https://image.civitai.com/a/b.png');
      const res = await originalFetch(`${app.url}/img?url=${target}&w=64`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      const buf = await res.arrayBuffer();
      expect(buf.byteLength).toBeGreaterThan(0);
    } finally { await app.close(); }
  });

  it('/launcher/img alias also works', async () => {
    const png = await tinyPng();
    installPassthroughMock(png);
    const app = await startApp();
    try {
      const target = encodeURIComponent('https://civitai.com/alias.png');
      const res = await originalFetch(`${app.url}/launcher/img?url=${target}&w=64`);
      expect(res.status).toBe(200);
    } finally { await app.close(); }
  });
});
