// Slug, collision, and enabledMcpTools migration coverage for settings.mcp.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---- per-test temp config file --------------------------------------------
//
// The settings module captures `paths.configFile` at module-load time and
// keeps an in-memory cache. To get a fresh, isolated config per test we
// (1) point STUDIO_CONFIG_FILE at a new tmpdir, then (2) call
// `vi.resetModules()` so the next `await import(...)` reloads `paths.ts`,
// `settings.ts`, and `settings.mcp.ts` against the new env var.

let tmpDir: string;
let savedConfig: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-slug-test-'));
  savedConfig = process.env.STUDIO_CONFIG_FILE;
  process.env.STUDIO_CONFIG_FILE = path.join(tmpDir, 'config.json');
  vi.resetModules();
});

afterEach(() => {
  if (savedConfig !== undefined) process.env.STUDIO_CONFIG_FILE = savedConfig;
  else delete process.env.STUDIO_CONFIG_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- slugifyServerName ----------------------------------------------------

describe('slugifyServerName', () => {
  it('lowercases and dashes non-alphanumerics', async () => {
    const { slugifyServerName } = await import('../../src/services/settings/mcp.js');
    expect(slugifyServerName('Context 7')).toBe('context-7');
    expect(slugifyServerName('My Crawler!')).toBe('my-crawler');
    expect(slugifyServerName('   spaced   out   ')).toBe('spaced-out');
  });

  it('collapses runs of separators', async () => {
    const { slugifyServerName } = await import('../../src/services/settings/mcp.js');
    expect(slugifyServerName('a---b___c')).toBe('a-b-c');
  });

  it('falls back to a UUID-derived stub for empty/non-alnum names', async () => {
    const { slugifyServerName } = await import('../../src/services/settings/mcp.js');
    expect(slugifyServerName('!!!', 'abcd1234-ef56')).toBe('srv-abcd1234');
    expect(slugifyServerName('')).toBe('srv');
  });
});

// ---- collision rejection --------------------------------------------------

describe('addMcpServer / updateMcpServer collision rejection', () => {
  it('rejects a second server whose name slugs identically', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    mod.addMcpServer({ name: 'Context 7', transport: 'http', url: 'http://x', enabled: true });
    expect(() =>
      mod.addMcpServer({ name: 'context-7', transport: 'http', url: 'http://y', enabled: true }),
    ).toThrow(mod.McpSlugCollisionError);
  });

  it('allows updating a server to a name that slugs to the same slug as before', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const first = mod.addMcpServer({ name: 'Context 7', transport: 'http', url: 'http://x', enabled: true });
    // Renaming the SAME server with another name that slugs to 'context-7' is fine —
    // the only collision check filters out the server's own row.
    expect(() => mod.updateMcpServer(first.id, { name: 'CONTEXT 7' })).not.toThrow();
  });

  it('rejects rename that collides with another server', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    mod.addMcpServer({ name: 'Context 7', transport: 'http', url: 'http://x', enabled: true });
    const second = mod.addMcpServer({ name: 'Crawler', transport: 'http', url: 'http://y', enabled: true });
    expect(() => mod.updateMcpServer(second.id, { name: 'Context 7' })).toThrow(mod.McpSlugCollisionError);
  });
});

// ---- enabledMcpTools migration -------------------------------------------

describe('migrateEnabledMcpToolKeys', () => {
  it('rewrites mcp__<UUID>__<tool> to mcp__<slug>__<tool> when UUID matches a server', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const server = mod.addMcpServer({ name: 'Context 7', transport: 'http', url: 'http://x', enabled: true });

    // Seed an old-shape entry directly in settings via the public toggle API.
    const toolsMod = await import('../../src/services/settings/tools.js');
    toolsMod.setEnabledMcpTools({
      [`mcp__${server.id}__resolve-library-id`]: true,
      [`mcp__${server.id}__get-library-docs`]: true,
      'studio_remember': true,                         // unrelated, must survive untouched
    });

    const rewrites = mod.migrateEnabledMcpToolKeys();
    expect(rewrites).toBe(2);

    const enabled = toolsMod.getEnabledMcpTools();
    expect(enabled['mcp__context-7__resolve-library-id']).toBe(true);
    expect(enabled['mcp__context-7__get-library-docs']).toBe(true);
    expect(enabled[`mcp__${server.id}__resolve-library-id`]).toBeUndefined();
    expect(enabled['studio_remember']).toBe(true);
  });

  it('is idempotent — second run is a no-op', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const server = mod.addMcpServer({ name: 'Context 7', transport: 'http', url: 'http://x', enabled: true });

    const toolsMod = await import('../../src/services/settings/tools.js');
    toolsMod.setEnabledMcpTools({ [`mcp__${server.id}__foo`]: true });

    expect(mod.migrateEnabledMcpToolKeys()).toBe(1);
    expect(mod.migrateEnabledMcpToolKeys()).toBe(0);
  });

  it('leaves orphaned UUID keys (no matching server) untouched', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const toolsMod = await import('../../src/services/settings/tools.js');
    toolsMod.setEnabledMcpTools({
      'mcp__deadbeef-1234-5678-90ab-cdef00000000__some-tool': true,
    });
    expect(mod.migrateEnabledMcpToolKeys()).toBe(0);
    expect(toolsMod.getEnabledMcpTools()['mcp__deadbeef-1234-5678-90ab-cdef00000000__some-tool']).toBe(true);
  });
});

// ---- enabled-flag <-> default-profile mirroring -------------------------

describe('addMcpServer / updateMcpServer mirror to default profile', () => {
  it('addMcpServer({ enabled: true }) grants `*` in the default profile', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const s = mod.addMcpServer({ name: 'Context 7', transport: 'http', url: 'http://x', enabled: true });
    const profiles = mod.getMcpProfiles();
    expect(profiles['studio-chat-default']?.[s.id]).toBe('*');
  });

  it('addMcpServer({ enabled: false }) leaves the profile untouched', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const s = mod.addMcpServer({ name: 'Crawl', transport: 'http', url: 'http://x', enabled: false });
    const profiles = mod.getMcpProfiles();
    expect(profiles['studio-chat-default']?.[s.id]).toBeUndefined();
  });

  it('toggling enabled false→true via updateMcpServer adds the profile entry', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const s = mod.addMcpServer({ name: 'Tool', transport: 'http', url: 'http://x', enabled: false });
    expect(mod.getMcpProfiles()['studio-chat-default']?.[s.id]).toBeUndefined();
    mod.updateMcpServer(s.id, { enabled: true });
    expect(mod.getMcpProfiles()['studio-chat-default']?.[s.id]).toBe('*');
  });

  it('toggling enabled true→false via updateMcpServer removes the profile entry', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const s = mod.addMcpServer({ name: 'Tool', transport: 'http', url: 'http://x', enabled: true });
    expect(mod.getMcpProfiles()['studio-chat-default']?.[s.id]).toBe('*');
    mod.updateMcpServer(s.id, { enabled: false });
    expect(mod.getMcpProfiles()['studio-chat-default']?.[s.id]).toBeUndefined();
  });

  it('removeMcpServer scrubs the deleted server from every named profile', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    const a = mod.addMcpServer({ name: 'A', transport: 'http', url: 'http://x', enabled: true });
    const b = mod.addMcpServer({ name: 'B', transport: 'http', url: 'http://y', enabled: true });
    // Curate a second profile that references both servers.
    mod.upsertMcpProfile('custom', { [a.id]: '*', [b.id]: ['some-tool'] });
    mod.removeMcpServer(a.id);
    const profiles = mod.getMcpProfiles();
    expect(profiles['studio-chat-default']?.[a.id]).toBeUndefined();
    expect(profiles['studio-chat-default']?.[b.id]).toBe('*');     // untouched
    expect(profiles['custom']?.[a.id]).toBeUndefined();
    expect(profiles['custom']?.[b.id]).toEqual(['some-tool']);     // untouched
  });
});

// ---- migrateMcpProfilesFromEnabled (one-shot backfill) ------------------

describe('migrateMcpProfilesFromEnabled', () => {
  it('grants `*` to every enabled server with no existing profile entry', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    // Seed servers WITHOUT going through addMcpServer, to simulate a pre-fix
    // settings file where no profile entries exist.
    mod.setMcpServers([
      { id: 'srv-1', name: 'one', transport: 'http', url: 'http://a', enabled: true },
      { id: 'srv-2', name: 'two', transport: 'http', url: 'http://b', enabled: true },
      { id: 'srv-3', name: 'three', transport: 'http', url: 'http://c', enabled: false },
    ]);
    const added = mod.migrateMcpProfilesFromEnabled();
    expect(added).toBe(2);
    const def = mod.getMcpProfiles()['studio-chat-default']!;
    expect(def['srv-1']).toBe('*');
    expect(def['srv-2']).toBe('*');
    expect(def['srv-3']).toBeUndefined();
  });

  it('leaves hand-curated profile entries untouched', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    mod.setMcpServers([
      { id: 'srv-x', name: 'x', transport: 'http', url: 'http://x', enabled: true },
    ]);
    mod.upsertMcpProfile('studio-chat-default', { 'srv-x': ['only-this-tool'] });
    expect(mod.migrateMcpProfilesFromEnabled()).toBe(0);
    expect(mod.getMcpProfiles()['studio-chat-default']?.['srv-x']).toEqual(['only-this-tool']);
  });

  it('is idempotent — second run is a no-op', async () => {
    const mod = await import('../../src/services/settings/mcp.js');
    mod.setMcpServers([
      { id: 'srv-y', name: 'y', transport: 'http', url: 'http://y', enabled: true },
    ]);
    expect(mod.migrateMcpProfilesFromEnabled()).toBe(1);
    expect(mod.migrateMcpProfilesFromEnabled()).toBe(0);
  });
});
