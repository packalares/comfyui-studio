// Tests for GET /api/chat/attachments/:slug — DB-backed lookup + traversal
// guards. The route resolves <id>.<ext>, looks up the chat_attachments row,
// then serves the file. Uses a lightweight http.createServer + fetch to
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
let goodId = '';

vi.mock('../../../src/config/paths.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/config/paths.js')>();
  return {
    ...actual,
    paths: {
      ...actual.paths,
      get runtimeStateDir() { return tmpDir; },
      get sqlitePath() {
        const override = process.env.STUDIO_SQLITE_PATH;
        return (override && override.length > 0)
          ? override
          : path.join(tmpDir, 'studio.db');
      },
    },
  };
});

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-route-test-'));
  process.env.STUDIO_SQLITE_PATH = path.join(tmpDir, 'studio.db');

  const { resetForTests } = await import('../../../src/lib/db/connection.js');
  resetForTests();
  const repo = await import('../../../src/lib/db/chat.repo.js');
  const attach = await import('../../../src/services/chat/attachments.js');

  // Seed conv + msg + attachment row + on-disk file.
  const now = Date.now();
  repo.createConversation({ id: 'c1', title: 't', model: 'm', created_at: now, updated_at: now });
  repo.appendMessage({ id: 'm1', conversation_id: 'c1', role: 'user', parts: '[]', created_at: now });
  const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
  const { id } = attach.persistAttachmentBytes(buf, {
    conversationId: 'c1', messageId: 'm1', mimeType: 'image/png', source: 'user',
  });
  goodId = id;

  const { default: router } = await import('../../../src/routes/chat.attachments.routes.js');
  const app = express();
  app.use(router);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server?.close();
  const { resetForTests } = await import('../../../src/lib/db/connection.js');
  resetForTests();
  delete process.env.STUDIO_SQLITE_PATH;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function get(url: string): Promise<{ status: number; contentType: string }> {
  const res = await fetch(baseUrl + url);
  return { status: res.status, contentType: res.headers.get('content-type') ?? '' };
}

describe('GET /chat/attachments/:slug', () => {
  it('serves the file when a row + bytes exist', async () => {
    const { status, contentType } = await get(`/chat/attachments/${goodId}.png`);
    expect(status).toBe(200);
    expect(contentType).toMatch(/image\/png/);
  });

  it('returns 404 when the row does not exist', async () => {
    const { status } = await get('/chat/attachments/doesnotexist.png');
    expect(status).toBe(404);
  });

  it('returns 404 when the row exists but extension does not match', async () => {
    const { status } = await get(`/chat/attachments/${goodId}.jpg`);
    expect(status).toBe(404);
  });

  it('rejects slug with .. (URL-encoded)', async () => {
    const { status } = await get('/chat/attachments/..%2Fetc%2Fpasswd');
    expect([400, 404]).toContain(status);
  });

  it('rejects slug with backslash', async () => {
    const { status } = await get('/chat/attachments/foo%5Cbar.png');
    expect(status).toBe(400);
  });

  it('rejects slug containing a forward slash after decode', async () => {
    const { status } = await get('/chat/attachments/foo%2Fbar.png');
    expect([400, 404]).toContain(status);
  });
});
