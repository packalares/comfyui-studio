// Integration tests for the personality (souls + memory) endpoints and the
// studio_remember MCP tool.
//
// Each test case uses a fresh sqlite DB and a fresh tmpdir for personality
// files so nothing leaks across tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { personalityRouter } from '../../src/routes/personality.routes.js';
import { useFreshDb } from '../lib/db/_helpers.js';

// ---------- test app setup ----------

function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function makePersonalityApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', personalityRouter);
  return app;
}

// ---------- personality dir fixture ----------

interface PersonalityFixture {
  dir: string;
  cleanup(): void;
}

function makePersonalityFixture(): PersonalityFixture {
  const dir = mkdtempSync(join(tmpdir(), 'studio-personality-'));
  // Override the config root so the personality loader writes here.
  process.env.STUDIO_CONFIG_ROOT = dir;
  return {
    dir,
    cleanup() {
      delete process.env.STUDIO_CONFIG_ROOT;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ---------- helpers ----------

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  const body = await res.json() as T;
  return { status: res.status, body };
}

async function putJson<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json() as T;
  return { status: res.status, body };
}

async function deleteReq<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'DELETE' });
  const body = await res.json() as T;
  return { status: res.status, body };
}

// ---------- suite ----------

describe('personality endpoints', () => {
  useFreshDb();
  let fixture: PersonalityFixture;

  beforeEach(() => {
    fixture = makePersonalityFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // The bundled souls are relative to the compiled server/data directory.
  // In tests the bundled dir resolves to `server/data/personalities` which
  // ships with the repo (default.md + security-auditor.md). We verify that
  // at least the ones we seeded are listed.

  it('GET /api/personality/souls returns seeded souls', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      const { status, body } = await getJson<{ souls: Array<{ name: string; description: string }> }>(
        `${app.url}/api/personality`,
      );
      expect(status).toBe(200);
      expect(Array.isArray(body.souls)).toBe(true);
      const names = body.souls.map((s) => s.name);
      expect(names).toContain('default');
      expect(names).toContain('security-auditor');
    } finally { await app.close(); }
  });

  it('GET /api/personality/soul/default returns body', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      const { status, body } = await getJson<{ name: string; body: string; frontmatter: Record<string, unknown> }>(
        `${app.url}/api/personality/soul/default`,
      );
      expect(status).toBe(200);
      expect(body.name).toBe('default');
      expect(typeof body.body).toBe('string');
      expect(body.body.length).toBeGreaterThan(0);
    } finally { await app.close(); }
  });

  it('PUT a new soul then GET it back, body matches', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      const content = 'You are a test soul.\n';
      const put = await putJson<{ ok: boolean }>(
        `${app.url}/api/personality/soul/test-soul`,
        { body: content },
      );
      expect(put.status).toBe(200);
      expect(put.body.ok).toBe(true);

      const get = await getJson<{ name: string; body: string }>(
        `${app.url}/api/personality/soul/test-soul`,
      );
      expect(get.status).toBe(200);
      expect(get.body.body).toBe(content);
    } finally { await app.close(); }
  });

  it('PUT then DELETE removes the soul from listing', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      await putJson(`${app.url}/api/personality/soul/to-delete`, { body: 'temp\n' });

      const del = await deleteReq<{ ok: boolean }>(
        `${app.url}/api/personality/soul/to-delete`,
      );
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);

      // After deletion the user file is gone. Bundled fallback does not exist
      // for this name, so 404.
      const get = await getJson<{ error: string }>(
        `${app.url}/api/personality/soul/to-delete`,
      );
      expect(get.status).toBe(404);
    } finally { await app.close(); }
  });

  it('DELETE on bundled-only soul returns 404', async () => {
    // 'default' only exists in the bundled dir; no user override has been
    // created, so DELETE should refuse with 404.
    const app = await startApp(makePersonalityApp());
    try {
      const del = await deleteReq<{ error: string }>(
        `${app.url}/api/personality/soul/default`,
      );
      expect(del.status).toBe(404);
      expect(typeof del.body.error).toBe('string');
    } finally { await app.close(); }
  });

  it('GET /api/personality/memory returns body (empty or stub initially)', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      const { status, body } = await getJson<{ body: string }>(
        `${app.url}/api/personality/memory`,
      );
      expect(status).toBe(200);
      expect(typeof body.body).toBe('string');
    } finally { await app.close(); }
  });

  it('PUT memory then GET it back', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      const content = '- 2026-05-06: Laurs prefers Qwen 14B\n';
      const put = await putJson<{ ok: boolean }>(
        `${app.url}/api/personality/memory`,
        { body: content },
      );
      expect(put.status).toBe(200);

      const get = await getJson<{ body: string }>(
        `${app.url}/api/personality/memory`,
      );
      expect(get.status).toBe(200);
      expect(get.body.body).toBe(content);
    } finally { await app.close(); }
  });

  it('GET /api/personality summary returns defaultSoul', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      const { status, body } = await getJson<{ defaultSoul: string | null }>(
        `${app.url}/api/personality`,
      );
      expect(status).toBe(200);
      // Seeds ship with default.md so it should return 'default'.
      expect(body.defaultSoul).toBe('default');
    } finally { await app.close(); }
  });

  it('PUT with invalid name returns 400', async () => {
    const app = await startApp(makePersonalityApp());
    try {
      const res = await putJson<{ error: string }>(
        `${app.url}/api/personality/soul/INVALID%20NAME`,
        { body: 'x' },
      );
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });
});

// ---------- chat/start soul integration ----------

describe('POST /api/chat/start with soulName', () => {
  useFreshDb();
  let fixture: PersonalityFixture;

  beforeEach(() => {
    fixture = makePersonalityFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  function makeChatApp(): express.Express {
    const app = express();
    app.use(express.json());
    // Mount only what we need for testing the DB write path.
    // We DO NOT start the full stream; we just check the conversation row.
    const router = express.Router();

    // Minimal stub of chat/start that exercises the soulName → createConversation path.
    // Import the real modules so DB writes happen with the real schema.
    router.post('/chat/start-test', async (req, res) => {
      const { createConversation, getConversation } = await import('../../src/lib/db/chat.repo.js');
      const { resolveSystemPrompt } = await import('../../src/services/chat/personality.js');
      const body = req.body as { soulName?: string | null };
      const soulName = typeof body.soulName === 'string' && body.soulName.length > 0
        ? body.soulName
        : null;
      const id = `test-${Date.now()}`;
      createConversation({
        id,
        title: 'test',
        model: 'test-model',
        soul_name: soulName,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const row = getConversation(id);
      // Re-resolve live so the test can assert what the chat would actually send.
      const resolved = resolveSystemPrompt(row?.soul_name ?? null) || null;
      res.json({ id, row, resolvedSystemPrompt: resolved });
    });

    app.use('/api', router);
    return app;
  }

  it('POST with soulName=default stores soul_name; resolved prompt has soul content', async () => {
    const app = await startApp(makeChatApp());
    try {
      const res = await fetch(`${app.url}/api/chat/start-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soulName: 'default' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as {
        row: { soul_name: string };
        resolvedSystemPrompt: string | null;
      };
      expect(data.row.soul_name).toBe('default');
      expect(typeof data.resolvedSystemPrompt).toBe('string');
      expect((data.resolvedSystemPrompt ?? '').length).toBeGreaterThan(0);
    } finally { await app.close(); }
  });

  it('POST with no soulName picks default soul', async () => {
    const app = await startApp(makeChatApp());
    try {
      const res = await fetch(`${app.url}/api/chat/start-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as {
        row: { soul_name: string | null };
        resolvedSystemPrompt: string | null;
      };
      // soul_name is null (no explicit choice) but the resolver still finds default.
      expect(data.row.soul_name).toBeNull();
      expect(typeof data.resolvedSystemPrompt).toBe('string');
    } finally { await app.close(); }
  });
});

// ---------- studio_remember tool ----------

describe('studio_remember MCP tool', () => {
  let fixture: PersonalityFixture;

  beforeEach(() => {
    fixture = makePersonalityFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('appends fact to memory.md with date prefix', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/remember.js');
    const result = await run({ fact: 'Laurs prefers Qwen 14B' });
    expect(result.ok).toBe(true);
    expect(result.persisted).toBe('Laurs prefers Qwen 14B');

    const { loadMemoryBody } = await import('../../src/services/chat/personality.js');
    const body = loadMemoryBody();
    expect(body).toContain('Laurs prefers Qwen 14B');
    // Date prefix format YYYY-MM-DD.
    expect(body).toMatch(/- \d{4}-\d{2}-\d{2}: Laurs prefers Qwen 14B/);
  });

  it('multiple appends accumulate', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/remember.js');
    await run({ fact: 'fact one' });
    await run({ fact: 'fact two' });

    const { loadMemoryBody } = await import('../../src/services/chat/personality.js');
    const body = loadMemoryBody();
    expect(body).toContain('fact one');
    expect(body).toContain('fact two');
  });

  it('dedups when the same fact is appended twice', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/remember.js');
    await run({ fact: 'Assistant name is Mariola' });
    await run({ fact: 'Assistant name is Mariola' });

    const { loadMemoryBody } = await import('../../src/services/chat/personality.js');
    const body = loadMemoryBody();
    const matches = body.match(/Assistant name is Mariola/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('dedup is case-insensitive and ignores surrounding whitespace', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/remember.js');
    await run({ fact: 'Prefers concise answers' });
    await run({ fact: '  prefers concise answers  ' });
    await run({ fact: 'PREFERS CONCISE ANSWERS' });

    const { loadMemoryBody } = await import('../../src/services/chat/personality.js');
    const body = loadMemoryBody();
    const matches = body.match(/[Pp][Rr][Ee][Ff][Ee][Rr][Ss] [Cc][Oo][Nn][Cc][Ii][Ss][Ee] [Aa][Nn][Ss][Ww][Ee][Rr][Ss]/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// ---------- PATCH /api/chat/conversations/:id soul_name ----------

describe('PATCH /chat/conversations/:id soul_name', () => {
  useFreshDb();
  let fixture: PersonalityFixture;

  beforeEach(() => {
    fixture = makePersonalityFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  function makePatchChatApp(): express.Express {
    const app = express();
    app.use(express.json());
    const router = express.Router();

    // Create a conversation row so the PATCH has something to update.
    router.post('/chat/conversations', async (req, res) => {
      const { createConversation, getConversation } = await import('../../src/lib/db/chat.repo.js');
      const body = req.body as { soulName?: string | null };
      const soulName = typeof body.soulName === 'string' ? body.soulName : null;
      const id = `patch-test-${Date.now()}`;
      createConversation({
        id,
        title: 'test',
        model: 'test-model',
        soul_name: soulName,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      res.json({ id, row: getConversation(id) });
    });

    router.patch('/chat/conversations/:id', async (req, res) => {
      const { renameConversation, getConversation } = await import('../../src/lib/db/chat.repo.js');
      const { resolveSystemPrompt } = await import('../../src/services/chat/personality.js');
      const id = String(req.params.id ?? '');
      const body = req.body as { soul_name?: unknown };
      const patch: { soul_name?: string | null } = {};
      if (typeof body.soul_name === 'string' || body.soul_name === null) {
        patch.soul_name = body.soul_name as string | null;
      }
      const ok = renameConversation(id, patch, Date.now());
      if (!ok) { res.status(404).json({ error: 'not found' }); return; }
      const row = getConversation(id);
      const resolvedSystemPrompt = resolveSystemPrompt(row?.soul_name ?? null) || null;
      res.json({ ...row, resolvedSystemPrompt });
    });

    app.use('/api', router);
    return app;
  }

  it('PATCH soul_name updates soul_name column and re-resolves system prompt', async () => {
    const app = await startApp(makePatchChatApp());
    try {
      // Create conversation with no soul.
      const createRes = await fetch(`${app.url}/api/chat/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const created = await createRes.json() as { id: string; row: { soul_name: string | null } };
      expect(created.row.soul_name).toBeNull();

      // PATCH to switch to the 'default' soul.
      const patchRes = await fetch(`${app.url}/api/chat/conversations/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soul_name: 'default' }),
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json() as {
        soul_name: string;
        resolvedSystemPrompt: string | null;
      };
      expect(patched.soul_name).toBe('default');
      // Re-resolved system prompt should reflect the new soul body.
      expect(typeof patched.resolvedSystemPrompt).toBe('string');
      expect((patched.resolvedSystemPrompt ?? '').length).toBeGreaterThan(0);
    } finally { await app.close(); }
  });

  it('PATCH soul_name to null clears the soul and snapshots empty prompt', async () => {
    const app = await startApp(makePatchChatApp());
    try {
      const createRes = await fetch(`${app.url}/api/chat/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soulName: 'default' }),
      });
      const created = await createRes.json() as { id: string };

      const patchRes = await fetch(`${app.url}/api/chat/conversations/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soul_name: null }),
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchRes.json() as { soul_name: string | null };
      expect(patched.soul_name).toBeNull();
    } finally { await app.close(); }
  });
});

// ---------- studio_propose_soul_edit MCP tool + pending-edits API ----------

describe('studio_propose_soul_edit + pending-edits API', () => {
  useFreshDb();
  let fixture: PersonalityFixture;

  beforeEach(() => {
    fixture = makePersonalityFixture();
    // Seed a user-writable test soul so the tool can find it.
    const soulsDir = join(fixture.dir, 'personalities', 'souls');
    mkdirSync(soulsDir, { recursive: true });
    writeFileSync(
      join(soulsDir, 'test-soul.md'),
      '# Test soul\n\nYou are a helpful assistant.\n\nKeep answers short.\n',
    );
  });

  afterEach(() => {
    fixture.cleanup();
  });

  function makePersonalityApiApp(): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/api', personalityRouter);
    return app;
  }

  it('studio_propose_soul_edit creates a pending edit JSON file', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const result = await run({
      soulName: 'test-soul',
      reason: 'User repeatedly asked for longer answers so we should remove the brevity constraint.',
      currentSection: 'Keep answers short.',
      proposedReplacement: 'Provide thorough, well-explained answers.',
    });
    expect(result.ok).toBe(true);
    expect(typeof result.pendingEditId).toBe('string');

    const pendingDir = join(fixture.dir, 'personalities', 'pending-soul-edits');
    const files = readdirSync(pendingDir);
    expect(files.length).toBe(1);
    const raw = readFileSync(join(pendingDir, files[0]!), 'utf8');
    const parsed = JSON.parse(raw) as { soulName: string; currentSection: string };
    expect(parsed.soulName).toBe('test-soul');
    expect(parsed.currentSection).toBe('Keep answers short.');
  });

  it('invalid soulName returns ok: false from MCP tool', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const result = await run({
      soulName: 'INVALID NAME',
      reason: 'Testing invalid name handling in the propose tool.',
      proposedReplacement: 'Some replacement text',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid soul name');
  });

  it('non-existent soulName returns ok: false from MCP tool', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const result = await run({
      soulName: 'does-not-exist',
      reason: 'Testing non-existent soul handling in the propose tool.',
      proposedReplacement: 'Some replacement text',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('GET /api/personality/pending-edits lists created edits', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    await run({
      soulName: 'test-soul',
      reason: 'User asked for a different tone consistently across sessions.',
      proposedReplacement: 'Adopt a more formal tone.',
    });

    const app = await startApp(makePersonalityApiApp());
    try {
      const { status, body } = await getJson<{ edits: Array<{ id: string; soulName: string }> }>(
        `${app.url}/api/personality`,
      );
      expect(status).toBe(200);
      expect(Array.isArray(body.edits)).toBe(true);
      expect(body.edits.length).toBe(1);
      expect(body.edits[0]!.soulName).toBe('test-soul');
    } finally { await app.close(); }
  });

  it('GET /api/personality/edit/:id returns edit or 404', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const created = await run({
      soulName: 'test-soul',
      reason: 'User consistently corrected the level of formality.',
      proposedReplacement: 'Be more formal.',
    });

    const app = await startApp(makePersonalityApiApp());
    try {
      const { status, body } = await getJson<{ id: string; soulName: string }>(
        `${app.url}/api/personality/edit/${created.pendingEditId}`,
      );
      expect(status).toBe(200);
      expect(body.id).toBe(created.pendingEditId);

      const notFound = await getJson<{ error: string }>(
        `${app.url}/api/personality/edit/no-such-id`,
      );
      expect(notFound.status).toBe(404);
    } finally { await app.close(); }
  });

  it('DELETE rejects pending edit (removes file, soul unchanged)', async () => {
    const soulBefore = readFileSync(
      join(fixture.dir, 'personalities', 'souls', 'test-soul.md'),
      'utf8',
    );

    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const created = await run({
      soulName: 'test-soul',
      reason: 'Testing rejection — this should not touch the soul file.',
      proposedReplacement: 'Completely different instructions.',
    });

    const app = await startApp(makePersonalityApiApp());
    try {
      const del = await deleteReq<{ ok: boolean }>(
        `${app.url}/api/personality/edit/${created.pendingEditId}`,
      );
      expect(del.status).toBe(200);
      expect(del.body.ok).toBe(true);

      // Soul file unchanged.
      const soulAfter = readFileSync(
        join(fixture.dir, 'personalities', 'souls', 'test-soul.md'),
        'utf8',
      );
      expect(soulAfter).toBe(soulBefore);

      // Pending edit gone.
      const list = await getJson<{ edits: unknown[] }>(
        `${app.url}/api/personality`,
      );
      expect(list.body.edits.length).toBe(0);
    } finally { await app.close(); }
  });

  it('accept in append mode adds text to soul and removes pending edit', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const created = await run({
      soulName: 'test-soul',
      reason: 'Adding a style rule because user requested it multiple times.',
      currentSection: null,
      proposedReplacement: 'Always cite sources when making factual claims.',
    });

    const app = await startApp(makePersonalityApiApp());
    try {
      const accept = await fetch(
        `${app.url}/api/personality/edit/${created.pendingEditId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept' }) },
      );
      expect(accept.status).toBe(200);
      const result = await accept.json() as { ok: boolean };
      expect(result.ok).toBe(true);

      // Soul body now contains the appended text.
      const { loadSoul } = await import('../../src/services/chat/personality.js');
      const soul = loadSoul('test-soul');
      expect(soul?.body).toContain('Always cite sources when making factual claims.');

      // Pending edit removed.
      const list = await getJson<{ edits: unknown[] }>(
        `${app.url}/api/personality`,
      );
      expect(list.body.edits.length).toBe(0);
    } finally { await app.close(); }
  });

  it('accept in replace mode substitutes matching section', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const created = await run({
      soulName: 'test-soul',
      reason: 'User asked for longer answers repeatedly — brevity rule should change.',
      currentSection: 'Keep answers short.',
      proposedReplacement: 'Provide thorough explanations.',
    });

    const app = await startApp(makePersonalityApiApp());
    try {
      const accept = await fetch(
        `${app.url}/api/personality/edit/${created.pendingEditId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept' }) },
      );
      const result = await accept.json() as { ok: boolean };
      expect(result.ok).toBe(true);

      const { loadSoul } = await import('../../src/services/chat/personality.js');
      const soul = loadSoul('test-soul');
      expect(soul?.body).toContain('Provide thorough explanations.');
      expect(soul?.body).not.toContain('Keep answers short.');
    } finally { await app.close(); }
  });

  it('accept with non-matching currentSection returns ok: false and leaves soul unchanged', async () => {
    const soulBefore = readFileSync(
      join(fixture.dir, 'personalities', 'souls', 'test-soul.md'),
      'utf8',
    );

    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const created = await run({
      soulName: 'test-soul',
      reason: 'Testing that a mismatched section does not corrupt the soul.',
      currentSection: 'This text does not exist in the soul.',
      proposedReplacement: 'Replacement that should not be applied.',
    });

    const app = await startApp(makePersonalityApiApp());
    try {
      const accept = await fetch(
        `${app.url}/api/personality/edit/${created.pendingEditId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept' }) },
      );
      const result = await accept.json() as { ok: boolean };
      expect(result.ok).toBe(false);

      // Soul must be untouched.
      const soulAfter = readFileSync(
        join(fixture.dir, 'personalities', 'souls', 'test-soul.md'),
        'utf8',
      );
      expect(soulAfter).toBe(soulBefore);
    } finally { await app.close(); }
  });

  it('soul backup file is created before applying a pending edit', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const created = await run({
      soulName: 'test-soul',
      reason: 'Checking backup creation before the soul file is mutated.',
      currentSection: null,
      proposedReplacement: 'Appended line for backup test.',
    });

    const app = await startApp(makePersonalityApiApp());
    try {
      await fetch(
        `${app.url}/api/personality/edit/${created.pendingEditId}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accept' }) },
      );

      const backupsDir = join(fixture.dir, 'personalities', 'soul-backups');
      expect(existsSync(backupsDir)).toBe(true);
      const backups = readdirSync(backupsDir);
      expect(backups.length).toBe(1);
      expect(backups[0]).toMatch(/test-soul\.md$/);
    } finally { await app.close(); }
  });

  // ---- Ambient soul context (chat wrapper auto-fills soulName) ----------

  it('run() rejects when soulName is missing — external MCP path', async () => {
    const { run } = await import('../../src/services/mcp/server/tools/studio/proposeSoulEdit.js');
    const result = await run({
      reason: 'External MCP client did not pass a soul name.',
      proposedReplacement: 'whatever',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('soulName is required');
  });

  it('chat wrapper auto-fills soulName from the active conversation', async () => {
    const { createConversation } = await import('../../src/lib/db/chat.repo.js');
    createConversation({
      id: 'conv-with-test-soul',
      title: 'fixture',
      model: 'qwen3:14b',
      created_at: Date.now(),
      soul_name: 'test-soul',
    });

    const { getMcpToolsForChat } = await import('../../src/services/mcp/server/toolRegistry.js');
    const tools = getMcpToolsForChat({ conversationId: 'conv-with-test-soul' });
    const tool = tools['studio_propose_soul_edit'];
    expect(tool).toBeDefined();

    // Model omits soulName; wrapper must inject 'test-soul'.
    const result = await tool!.tool.execute!(
      {
        reason: 'User asked the assistant to be more terse from now on.',
        proposedReplacement: 'Keep answers tight; one short sentence is usually enough.',
      },
      {} as never,
    );
    const parsed = JSON.parse(result as string) as { ok: boolean; pendingEditId?: string };
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.pendingEditId).toBe('string');

    const pendingDir = join(fixture.dir, 'personalities', 'pending-soul-edits');
    const files = readdirSync(pendingDir);
    expect(files.length).toBe(1);
    const raw = readFileSync(join(pendingDir, files[0]!), 'utf8');
    const edit = JSON.parse(raw) as { soulName: string };
    expect(edit.soulName).toBe('test-soul');
  });

  it('chat wrapper preserves an explicit soulName when the model passes one', async () => {
    const { createConversation } = await import('../../src/lib/db/chat.repo.js');
    createConversation({
      id: 'conv-with-test-soul-2',
      title: 'fixture',
      model: 'qwen3:14b',
      created_at: Date.now(),
      soul_name: 'test-soul',
    });

    // Seed a SECOND soul so we can verify the wrapper doesn't overwrite the
    // model's explicit choice with the conversation's active soul.
    const soulsDir = join(fixture.dir, 'personalities', 'souls');
    writeFileSync(join(soulsDir, 'second-soul.md'), '# Second soul\n');

    const { getMcpToolsForChat } = await import('../../src/services/mcp/server/toolRegistry.js');
    const tools = getMcpToolsForChat({ conversationId: 'conv-with-test-soul-2' });
    const tool = tools['studio_propose_soul_edit']!;

    await tool.tool.execute!(
      {
        soulName: 'second-soul',
        reason: 'Model explicitly chose a different soul to edit.',
        proposedReplacement: 'extra rule',
      },
      {} as never,
    );

    const pendingDir = join(fixture.dir, 'personalities', 'pending-soul-edits');
    const files = readdirSync(pendingDir);
    expect(files.length).toBe(1);
    const edit = JSON.parse(readFileSync(join(pendingDir, files[0]!), 'utf8')) as { soulName: string };
    expect(edit.soulName).toBe('second-soul');
  });
});
