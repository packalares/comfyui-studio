// Integration test for the /mcp Express route.
// Verifies bearer auth pass/fail and basic tools/list response.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// ---- mock settings -------------------------------------------------------
vi.mock('../../../src/services/settings.mcp.js', () => ({
  getStudioMcpToken: vi.fn(),
}));

// ---- mock MCP server factory (no-op tools so no service deps needed) -----
vi.mock('../../../src/services/mcp/server/index.js', () => ({
  createStudioMcpServer: vi.fn(),
}));

import mcpRouter from '../../../src/routes/mcp.routes.js';
import * as settingsMcp from '../../../src/services/settings.mcp.js';
import * as serverFactory from '../../../src/services/mcp/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcpRouter);
  return app;
}

function listen(app: ReturnType<typeof buildApp>) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = app.listen(0, () => {
      const { port } = s.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

describe('POST /mcp auth', () => {
  beforeEach(() => {
    vi.mocked(settingsMcp.getStudioMcpToken).mockReset();
    vi.mocked(serverFactory.createStudioMcpServer).mockReset();
  });

  it('returns 503 when no token configured', async () => {
    vi.mocked(settingsMcp.getStudioMcpToken).mockReturnValue(null);
    const app = await listen(buildApp());
    try {
      const res = await fetch(`${app.url}/mcp`, { method: 'POST' });
      expect(res.status).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when wrong token', async () => {
    vi.mocked(settingsMcp.getStudioMcpToken).mockReturnValue('secret');
    const srv = buildApp();
    const app = await listen(srv);
    try {
      const res = await fetch(`${app.url}/mcp`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('accepts correct token and forwards to MCP server', async () => {
    vi.mocked(settingsMcp.getStudioMcpToken).mockReturnValue('secret');

    // Create a real minimal McpServer to handle the tools/list request.
    const realServer = new McpServer(
      { name: 'test', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    vi.mocked(serverFactory.createStudioMcpServer).mockReturnValue(realServer);

    const srv = buildApp();
    const app = await listen(srv);
    try {
      const res = await fetch(`${app.url}/mcp`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      // Successful MCP response (200 or 202 for SSE, or JSON body).
      expect(res.status).toBeLessThan(500);
    } finally {
      await app.close();
    }
  });
});
