// Integration tests for GET /chat/conversations/:id/messages
// focusing on query-param validation (400 paths) and the paginated
// response shape { items, hasMore, oldestId }.
//
// Uses a real SQLite DB (via resetForTests) + a lightweight express server
// so we exercise the full request→repo→response pipeline.

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let server: http.Server;
let baseUrl: string;
const CONV_ID = 'conv-page-test';
const NOW = 2_000_000;

// Provide a deterministic sqlite path before any module imports that touch the DB.
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

// The chat route references settings for model defaults; provide minimal stubs
// so the route module loads without side-effects touching the filesystem.
vi.mock('../../../src/services/settings/index.js', () => ({
  getChatDefaultModel: () => 'test-model',
  getChatKeepAlive: () => '5m',
  getChatDefaultThinkMode: () => 'auto',
  getDefaultContextStrategy: () => 'sliding',
}));

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-page-route-test-'));
  process.env.STUDIO_SQLITE_PATH = path.join(tmpDir, 'studio.db');

  const { resetForTests } = await import('../../../src/lib/db/connection.js');
  resetForTests();

  const repo = await import('../../../src/lib/db/chat.repo.js');
  repo.createConversation({
    id: CONV_ID, title: 'test', model: 'm', created_at: NOW, updated_at: NOW,
  });
  // Seed 15 messages with distinct created_at values so order is deterministic.
  for (let i = 0; i < 15; i++) {
    repo.appendMessage({
      id: `pg${String(i).padStart(2, '0')}`,
      conversation_id: CONV_ID,
      role: i % 2 === 0 ? 'user' : 'assistant',
      parts: JSON.stringify([{ type: 'text', text: `msg${i}` }]),
      created_at: NOW + i,
    });
  }

  const { default: router } = await import('../../../src/routes/chat.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
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

async function getMessages(qs = '') {
  const url = `${baseUrl}/api/chat/conversations/${CONV_ID}/messages${qs}`;
  const res = await fetch(url);
  const body = await res.json() as unknown;
  return { status: res.status, body };
}

describe('GET /api/chat/conversations/:id/messages — pagination', () => {
  it('default (no params) returns all 15 messages with hasMore=false', async () => {
    const { status, body } = await getMessages();
    expect(status).toBe(200);
    const b = body as { items: unknown[]; hasMore: boolean; oldestId: string | null };
    expect(b.items.length).toBe(15);
    expect(b.hasMore).toBe(false);
    expect(b.oldestId).toBe('pg00');
  });

  it('limit=5 returns the 5 newest messages, hasMore=true', async () => {
    const { status, body } = await getMessages('?limit=5');
    expect(status).toBe(200);
    const b = body as { items: Array<{ id: string }>; hasMore: boolean; oldestId: string };
    expect(b.items.length).toBe(5);
    expect(b.hasMore).toBe(true);
    // 5 newest in ASC order: pg10 … pg14.
    expect(b.items[0].id).toBe('pg10');
    expect(b.items[4].id).toBe('pg14');
    expect(b.oldestId).toBe('pg10');
  });

  it('before cursor returns messages strictly older, correct hasMore', async () => {
    // Cursor at pg10 → should return pg05..pg09 (limit=5).
    const { status, body } = await getMessages('?limit=5&before=pg10');
    expect(status).toBe(200);
    const b = body as { items: Array<{ id: string }>; hasMore: boolean; oldestId: string };
    expect(b.items.length).toBe(5);
    expect(b.items[0].id).toBe('pg05');
    expect(b.items[4].id).toBe('pg09');
    // pg00..pg04 still exist → hasMore=true.
    expect(b.hasMore).toBe(true);
    expect(b.oldestId).toBe('pg05');
  });

  it('before cursor near the beginning returns hasMore=false', async () => {
    // Cursor at pg02 → only pg00 and pg01 are older (limit=50).
    const { status, body } = await getMessages('?limit=50&before=pg02');
    expect(status).toBe(200);
    const b = body as { items: Array<{ id: string }>; hasMore: boolean };
    expect(b.items.length).toBe(2);
    expect(b.hasMore).toBe(false);
  });

  it('limit=0 → 400', async () => {
    const { status } = await getMessages('?limit=0');
    expect(status).toBe(400);
  });

  it('limit=10000 → 400', async () => {
    const { status } = await getMessages('?limit=10000');
    expect(status).toBe(400);
  });

  it('limit=abc → 400', async () => {
    const { status } = await getMessages('?limit=abc');
    expect(status).toBe(400);
  });

  it('before= (empty string) → 400', async () => {
    const { status } = await getMessages('?before=');
    expect(status).toBe(400);
  });

  it('unknown conversation id → 404', async () => {
    const res = await fetch(`${baseUrl}/api/chat/conversations/no-such-conv/messages`);
    expect(res.status).toBe(404);
  });

  it('response rows carry the expected shape', async () => {
    const { body } = await getMessages('?limit=1');
    const b = body as { items: Array<Record<string, unknown>>; hasMore: boolean; oldestId: string };
    const row = b.items[0];
    expect(typeof row.id).toBe('string');
    expect(typeof row.conversationId).toBe('string');
    expect(typeof row.role).toBe('string');
    expect(Array.isArray(row.parts)).toBe(true);
    expect(typeof row.created_at).toBe('number');
  });
});
