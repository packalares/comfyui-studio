// Express router for Studio's streamable-HTTP MCP transport.
//
// Auth: requires `Authorization: Bearer <STUDIO_MCP_TOKEN>` on every request.
// If the token is not configured in settings, returns 503 (MCP not enabled).
// If the token is wrong, returns 401.
//
// The McpServer instance is created once and reused across stateless requests
// (sessionIdGenerator: undefined = stateless mode so every POST is
// self-contained and requires no session management).

import { Router } from 'express';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createStudioMcpServer } from '../services/mcp/server/index.js';
import { getStudioMcpToken } from '../services/settings/mcp.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Lazily created on first authenticated request, then reused.
let mcpServer: ReturnType<typeof createStudioMcpServer> | null = null;

function getOrCreateServer() {
  if (!mcpServer) mcpServer = createStudioMcpServer();
  return mcpServer;
}

function checkAuth(req: Request, res: Response): boolean {
  const token = getStudioMcpToken();
  if (!token) {
    res.status(503).json({ error: 'MCP server not configured' });
    return false;
  }
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Constant-time compare. JS `!==` short-circuits on the first differing
  // character, leaking the prefix length via response timing. timingSafeEqual
  // requires equal-length buffers, so we pre-check length to avoid a throw.
  const bearerBuf = Buffer.from(bearer);
  const tokenBuf = Buffer.from(token);
  const matches = bearerBuf.length === tokenBuf.length
    && timingSafeEqual(bearerBuf, tokenBuf);
  if (!matches) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

router.post('/', async (req: Request, res: Response) => {
  if (!checkAuth(req, res)) return;
  const server = getOrCreateServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.warn('MCP request error', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal server error' });
    }
  }
});

// GET for SSE / session resumption (MCP spec requirement).
router.get('/', async (req: Request, res: Response) => {
  if (!checkAuth(req, res)) return;
  const server = getOrCreateServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    logger.warn('MCP SSE request error', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal server error' });
    }
  }
});

// DELETE for session termination.
router.delete('/', async (req: Request, res: Response) => {
  if (!checkAuth(req, res)) return;
  res.status(200).json({ ok: true });
});

export default router;
