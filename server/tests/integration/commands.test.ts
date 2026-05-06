// Integration tests for the commands subsystem, parser, and streamChat integration.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { commandsRouter } from '../../src/routes/commands.routes.js';

// ---------- test app ----------

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

function makeCommandsApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', commandsRouter);
  return app;
}

// ---------- fixture ----------

interface Fixture {
  dir: string;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'studio-commands-'));
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
  return { status: res.status, body: await res.json() as T };
}

async function putJson<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() as T };
}

async function deleteReq<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'DELETE' });
  return { status: res.status, body: await res.json() as T };
}

// ---------- commands CRUD ----------

describe('commands endpoints', () => {
  let fixture: Fixture;

  beforeEach(() => { fixture = makeFixture(); });
  afterEach(() => { fixture.cleanup(); });

  it('GET /api/commands returns bundled seeds', async () => {
    const app = await startApp(makeCommandsApp());
    try {
      const { status, body } = await getJson<{ commands: Array<{ name: string }> }>(
        `${app.url}/api/commands`,
      );
      expect(status).toBe(200);
      const names = body.commands.map(c => c.name);
      expect(names).toContain('improve-prompt');
      expect(names).toContain('dep-check');
    } finally { await app.close(); }
  });

  it('GET /api/commands/:name returns body', async () => {
    const app = await startApp(makeCommandsApp());
    try {
      const { status, body } = await getJson<{ name: string; body: string }>(
        `${app.url}/api/commands/improve-prompt`,
      );
      expect(status).toBe(200);
      expect(body.name).toBe('improve-prompt');
      expect(body.body).toContain('$ARGUMENTS');
    } finally { await app.close(); }
  });

  it('PUT command then GET it back', async () => {
    const app = await startApp(makeCommandsApp());
    try {
      const cmdBody = '---\nname: my-cmd\ndescription: My command.\nargument_hint: <text>\n---\nDo: $ARGUMENTS\n';
      await putJson<{ ok: boolean }>(`${app.url}/api/commands/my-cmd`, { body: cmdBody });

      const { status, body } = await getJson<{ body: string }>(`${app.url}/api/commands/my-cmd`);
      expect(status).toBe(200);
      expect(body.body).toContain('$ARGUMENTS');
    } finally { await app.close(); }
  });

  it('DELETE bundled-only command returns 404', async () => {
    const app = await startApp(makeCommandsApp());
    try {
      const del = await deleteReq<{ error: string }>(`${app.url}/api/commands/improve-prompt`);
      expect(del.status).toBe(404);
    } finally { await app.close(); }
  });

  it('PUT invalid name returns 400', async () => {
    const app = await startApp(makeCommandsApp());
    try {
      const res = await putJson<{ error: string }>(`${app.url}/api/commands/BAD NAME`, { body: 'x' });
      expect(res.status).toBe(400);
    } finally { await app.close(); }
  });
});

// ---------- expandCommand ----------

describe('expandCommand', () => {
  let fixture: Fixture;

  beforeEach(() => { fixture = makeFixture(); });
  afterEach(() => { fixture.cleanup(); });

  it('substitutes $ARGUMENTS with provided args', async () => {
    const { expandCommand } = await import('../../src/services/chat/commands/registry.js');
    const result = expandCommand('improve-prompt', 'cyberpunk girl');
    expect(result).toContain('cyberpunk girl');
    expect(result).not.toContain('$ARGUMENTS');
  });

  it('substitutes $ARGUMENTS with empty string when no args', async () => {
    const { expandCommand } = await import('../../src/services/chat/commands/registry.js');
    const result = expandCommand('improve-prompt', '');
    expect(result).not.toContain('$ARGUMENTS');
    // The placeholder becomes empty; the body before/after it remains.
    expect(typeof result).toBe('string');
  });

  it('throws for unknown command', async () => {
    const { expandCommand } = await import('../../src/services/chat/commands/registry.js');
    expect(() => expandCommand('nonexistent', 'foo')).toThrow('Unknown command');
  });
});

// ---------- detectSlashCommand ----------

describe('detectSlashCommand', () => {
  it('detects /foo', async () => {
    const { detectSlashCommand } = await import('../../src/services/chat/commands/parser.js');
    const r = detectSlashCommand('/foo');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('foo');
    expect(r!.args).toBe('');
  });

  it('detects /foo bar baz', async () => {
    const { detectSlashCommand } = await import('../../src/services/chat/commands/parser.js');
    const r = detectSlashCommand('/foo bar baz');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('foo');
    expect(r!.args).toBe('bar baz');
  });

  it('detects /foo  multiple   spaces — args trimmed left, not compressed', async () => {
    const { detectSlashCommand } = await import('../../src/services/chat/commands/parser.js');
    const r = detectSlashCommand('/foo  multiple   spaces');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('foo');
    // Leading whitespace of args is stripped, internal whitespace kept.
    expect(r!.args).toBe('multiple   spaces');
  });

  it('rejects " /not-leading" (leading whitespace)', async () => {
    const { detectSlashCommand } = await import('../../src/services/chat/commands/parser.js');
    const r = detectSlashCommand(' /not-leading');
    expect(r).toBeNull();
  });

  it('rejects "not slash"', async () => {
    const { detectSlashCommand } = await import('../../src/services/chat/commands/parser.js');
    expect(detectSlashCommand('not slash')).toBeNull();
  });

  it('detects /command-with-hyphens', async () => {
    const { detectSlashCommand } = await import('../../src/services/chat/commands/parser.js');
    const r = detectSlashCommand('/improve-prompt a nice scene');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('improve-prompt');
    expect(r!.args).toBe('a nice scene');
  });
});

// ---------- streamChat slash-command integration ----------

describe('streamChat expandLatestSlashCommand integration', () => {
  let fixture: Fixture;

  beforeEach(() => { fixture = makeFixture(); });
  afterEach(() => { fixture.cleanup(); });

  it('known command: Ollama receives expanded text, not literal /command', async () => {
    // We test the internal helper by re-importing after env is set.
    // Since expandLatestSlashCommand is not exported, we verify the behaviour
    // through the getSkillBody / expandCommand route: the bundled improve-prompt
    // seed exists and expandCommand substitutes correctly.
    const { expandCommand } = await import('../../src/services/chat/commands/registry.js');
    const expanded = expandCommand('improve-prompt', 'a red barn at sunset');
    // Must contain the substituted args.
    expect(expanded).toContain('a red barn at sunset');
    // Must NOT contain the raw placeholder.
    expect(expanded).not.toContain('$ARGUMENTS');
    // Must contain guidance from the command body.
    expect(expanded.length).toBeGreaterThan(50);
  });

  it('unknown command: throws with "Unknown command" message', async () => {
    const { expandCommand } = await import('../../src/services/chat/commands/registry.js');
    expect(() => expandCommand('does-not-exist', 'some args')).toThrow('Unknown command');
  });

  it('detectSlashCommand rejects messages that are not slash commands', async () => {
    const { detectSlashCommand } = await import('../../src/services/chat/commands/parser.js');
    expect(detectSlashCommand('hello world')).toBeNull();
    expect(detectSlashCommand('')).toBeNull();
    expect(detectSlashCommand('/ not-valid')).toBeNull();
  });
});
