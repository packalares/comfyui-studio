// Route-level smoke tests for the unified thumbnail endpoints. Covers the
// URL-mode image path (mocked fetch), the stats endpoint, clear endpoint,
// and error cases (missing url, unsupported ext, 404 on unknown gallery id).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import sharp from 'sharp';

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } },
  }).png().toBuffer();
}

function pngResponse(body: Buffer): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(body.byteLength) },
  });
}

async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const { default: router } = await import('../../../src/routes/thumbnail.routes.js');
  const app = express();
  app.use(router);
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

describe('/thumbnail route', () => {
  let tmpRoot: string;
  let saved: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-route-test-'));
    saved = process.env.COMFYUI_PATH;
    process.env.COMFYUI_PATH = tmpRoot;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (saved !== undefined) process.env.COMFYUI_PATH = saved;
    else delete process.env.COMFYUI_PATH;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function installPassthroughMock(pngBody: Buffer): void {
    const real = originalFetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) {
        return real(input as RequestInfo, init);
      }
      return pngResponse(pngBody);
    }) as typeof fetch;
  }

  it('URL mode: 400 when url missing', async () => {
    const app = await startApp();
    try {
      const res = await originalFetch(`${app.url}/thumbnail?w=320`);
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });

  it('URL mode: 200 + image/webp on civitai-style URL', async () => {
    const png = await tinyPng();
    installPassthroughMock(png);
    const app = await startApp();
    try {
      const target = encodeURIComponent('https://civitai.com/a.png');
      const res = await originalFetch(`${app.url}/thumbnail?url=${target}&w=320`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(0);
    } finally { await app.close(); }
  });

  it('URL mode: 404 on unknown extension', async () => {
    const app = await startApp();
    try {
      const target = encodeURIComponent('https://civitai.com/a.xyz');
      const res = await originalFetch(`${app.url}/thumbnail?url=${target}&w=320`);
      expect(res.status).toBe(404);
    } finally { await app.close(); }
  });

  it('URL mode: 3D extension returns inline SVG', async () => {
    const app = await startApp();
    try {
      const target = encodeURIComponent('https://civitai.com/model.glb');
      const res = await originalFetch(`${app.url}/thumbnail?url=${target}&w=320`);
      expect(res.status).toBe(200);
      // Express appends `; charset=utf-8` for text-ish types.
      expect(res.headers.get('content-type')?.startsWith('image/svg+xml')).toBe(true);
    } finally { await app.close(); }
  });

  it('ID mode: 404 when gallery id is unknown', async () => {
    const app = await startApp();
    try {
      const res = await originalFetch(`${app.url}/thumbnail/nonexistent?w=320`);
      expect(res.status).toBe(404);
    } finally { await app.close(); }
  });

  it('stats endpoint returns the expected shape', async () => {
    const app = await startApp();
    try {
      const res = await originalFetch(`${app.url}/thumbnail/stats`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        count: number; totalBytes: number; bucketCount: number;
      };
      expect(typeof body.count).toBe('number');
      expect(typeof body.totalBytes).toBe('number');
      expect(typeof body.bucketCount).toBe('number');
    } finally { await app.close(); }
  });

  it('DELETE /thumbnail/cache reports the count deleted', async () => {
    const app = await startApp();
    try {
      const res = await originalFetch(`${app.url}/thumbnail/cache`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json() as { deleted: number };
      expect(typeof body.deleted).toBe('number');
    } finally { await app.close(); }
  });
});
