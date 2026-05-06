// Tests for GET /api/chat/attachments/:filename — path traversal guards and
// happy-path file serving. Uses a lightweight http.createServer + fetch to
// avoid a supertest dependency.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let server: http.Server;
let baseUrl: string;

vi.mock('../../../src/services/chat/attachments.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/services/chat/attachments.js')>();
  return {
    ...actual,
    attachmentDir: () => tmpDir,
  };
});

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-route-test-'));
  // Write a test PNG file (4 bytes magic).
  fs.writeFileSync(path.join(tmpDir, 'test-abc123.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const { default: router } = await import('../../../src/routes/chat.attachments.routes.js');
  const app = express();
  app.use(router);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server?.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function get(url: string): Promise<{ status: number; contentType: string }> {
  const res = await fetch(baseUrl + url);
  return { status: res.status, contentType: res.headers.get('content-type') ?? '' };
}

describe('GET /chat/attachments/:filename', () => {
  it('serves an existing file with the correct Content-Type', async () => {
    const { status, contentType } = await get('/chat/attachments/test-abc123.png');
    expect(status).toBe(200);
    expect(contentType).toMatch(/image\/png/);
  });

  it('returns 404 for a missing file', async () => {
    const { status } = await get('/chat/attachments/does-not-exist.png');
    expect(status).toBe(404);
  });

  it('rejects filename with .. (URL-encoded)', async () => {
    const { status } = await get('/chat/attachments/..%2Fetc%2Fpasswd');
    expect([400, 404]).toContain(status);
  });

  it('rejects filename with backslash', async () => {
    const { status } = await get('/chat/attachments/foo%5Cbar.png');
    expect(status).toBe(400);
  });

  it('rejects filename containing a forward slash after decode', async () => {
    const { status } = await get('/chat/attachments/foo%2Fbar.png');
    // Express may handle the slash as a different route segment (404) or
    // the guard catches it (400). Either is correct security-wise.
    expect([400, 404]).toContain(status);
  });
});
