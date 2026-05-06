// Smoke tests for the MCP servers + profiles REST CRUD.
//
// Uses an in-process Express server; mocks settings storage and registry
// so no real MCP connections or file I/O occur.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// ---- Mock settings.mcp ----------------------------------------------------

let serverStore: import('../../src/services/settings.mcp.js').McpServerConfig[] = [];
let profileStore: Record<string, import('../../src/services/settings.mcp.js').Profile> = {
  'studio-chat-default': {},
};

vi.mock('../../src/services/settings.mcp.js', async () => {
  const { randomUUID } = await import('crypto');
  return {
    getMcpServers: () => serverStore,
    addMcpServer: (partial: Record<string, unknown>) => {
      const s = { ...partial, id: randomUUID() } as import('../../src/services/settings.mcp.js').McpServerConfig;
      serverStore.push(s);
      return s;
    },
    updateMcpServer: (id: string, patch: Record<string, unknown>) => {
      const idx = serverStore.findIndex((s) => s.id === id);
      if (idx === -1) return false;
      serverStore[idx] = { ...serverStore[idx], ...patch, id };
      return true;
    },
    removeMcpServer: (id: string) => {
      const prev = serverStore.length;
      serverStore = serverStore.filter((s) => s.id !== id);
      return serverStore.length < prev;
    },
    getMcpProfiles: () => profileStore,
    upsertMcpProfile: (name: string, profile: unknown) => {
      profileStore[name] = profile as import('../../src/services/settings.mcp.js').Profile;
    },
    DEFAULT_PROFILE_NAME: 'studio-chat-default',
  };
});

// ---- Mock registry --------------------------------------------------------

const mockRegistry = {
  getServerStates: vi.fn(() => serverStore.map((s) => ({
    ...s,
    state: { status: 'disconnected', toolCount: 0 },
  }))),
  scheduleReload: vi.fn(),
  disconnectServer: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/services/mcp/client/index.js', () => ({
  getRegistry: () => mockRegistry,
  McpClientRegistry: vi.fn(),
}));

// ---- Mock McpConnection.probe ---------------------------------------------

vi.mock('../../src/services/mcp/client/connection.js', () => ({
  McpConnection: class MockMcpConnection {
    probe = vi.fn().mockResolvedValue(3);
    disconnect = vi.fn().mockResolvedValue(undefined);
    status = 'disconnected';
  },
}));

// Import AFTER mocks
const mcpRouter = (await import('../../src/routes/mcpServers.routes.js')).default;

// ---- Test server ----------------------------------------------------------

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', mcpRouter);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = (server.address() as AddressInfo);
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---- Tests ----------------------------------------------------------------

describe('MCP servers CRUD', () => {
  let app: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    serverStore = [];
    profileStore = { 'studio-chat-default': {} };
    vi.clearAllMocks();
    mockRegistry.getServerStates.mockImplementation(() =>
      serverStore.map((s) => ({ ...s, state: { status: 'disconnected', toolCount: 0 } })),
    );
    app = await startApp();
  });

  it('GET /api/mcp/servers returns empty list initially', async () => {
    const res = await fetch(`${app.url}/api/mcp/servers`);
    const body = await res.json() as { servers: unknown[] };
    expect(res.status).toBe(200);
    expect(body.servers).toHaveLength(0);
    await app.close();
  });

  it('POST /api/mcp/servers creates a server', async () => {
    const res = await fetch(`${app.url}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ctx7', transport: 'stdio', command: 'npx', args: ['-y', 'ctx7'], enabled: true }),
    });
    const body = await res.json() as { server: { id: string; name: string } };
    expect(res.status).toBe(201);
    expect(body.server.name).toBe('ctx7');
    expect(typeof body.server.id).toBe('string');
    await app.close();
  });

  it('PUT /api/mcp/servers/:id updates a server', async () => {
    const postRes = await fetch(`${app.url}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'old', transport: 'stdio', command: 'npx', enabled: true }),
    });
    const { server } = await postRes.json() as { server: { id: string } };
    const putRes = await fetch(`${app.url}/api/mcp/servers/${server.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new' }),
    });
    expect(putRes.status).toBe(200);
    const updated = await putRes.json() as { server: { name: string } };
    expect(updated.server.name).toBe('new');
    await app.close();
  });

  it('DELETE /api/mcp/servers/:id removes a server', async () => {
    const postRes = await fetch(`${app.url}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'toDelete', transport: 'http', url: 'http://x', enabled: true }),
    });
    const { server } = await postRes.json() as { server: { id: string } };
    const delRes = await fetch(`${app.url}/api/mcp/servers/${server.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(serverStore).toHaveLength(0);
    await app.close();
  });

  it('POST /api/mcp/servers/:id/test returns ok with toolCount', async () => {
    const postRes = await fetch(`${app.url}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'testable', transport: 'stdio', command: 'npx', enabled: true }),
    });
    const { server } = await postRes.json() as { server: { id: string } };
    const testRes = await fetch(`${app.url}/api/mcp/servers/${server.id}/test`, { method: 'POST' });
    const result = await testRes.json() as { ok: boolean; toolCount?: number };
    expect(testRes.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.toolCount).toBe(3);
    await app.close();
  });
});

describe('MCP profiles CRUD', () => {
  let app: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    profileStore = { 'studio-chat-default': {} };
    app = await startApp();
  });

  it('GET /api/mcp/profiles returns profiles', async () => {
    const res = await fetch(`${app.url}/api/mcp/profiles`);
    const body = await res.json() as { profiles: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.profiles['studio-chat-default']).toBeDefined();
    await app.close();
  });

  it('PUT /api/mcp/profiles/:name upserts a profile', async () => {
    const res = await fetch(`${app.url}/api/mcp/profiles/my-profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'server-a': '*' }),
    });
    expect(res.status).toBe(200);
    expect(profileStore['my-profile']).toEqual({ 'server-a': '*' });
    await app.close();
  });
});
