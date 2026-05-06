// REST CRUD for MCP servers and profiles.
//
// GET    /api/mcp/servers          -> { servers } with live status
// POST   /api/mcp/servers          -> add server (id assigned by backend)
// PUT    /api/mcp/servers/:id      -> update
// DELETE /api/mcp/servers/:id      -> remove + disconnect
// POST   /api/mcp/servers/:id/test -> { ok, toolCount?, error? }
// GET    /api/mcp/profiles         -> { profiles }
// PUT    /api/mcp/profiles/:name   -> upsert profile

import { Router, type Request, type Response } from 'express';
import {
  getMcpServers,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
  getMcpProfiles,
  upsertMcpProfile,
  type McpServerConfig,
} from '../services/settings.mcp.js';
import { getRegistry } from '../services/mcp/client/index.js';
import { McpConnection } from '../services/mcp/client/connection.js';

const router = Router();

// ---- Servers ----------------------------------------------------------------

router.get('/mcp/servers', (_req: Request, res: Response) => {
  const states = getRegistry().getServerStates();
  res.json({ servers: states });
});

router.post('/mcp/servers', (req: Request, res: Response) => {
  const body = req.body as Partial<Omit<McpServerConfig, 'id'>>;
  if (!body.name || !body.transport) {
    res.status(400).json({ error: 'name and transport are required' });
    return;
  }
  const server = addMcpServer({
    name: body.name,
    transport: body.transport,
    command: body.command,
    args: body.args,
    url: body.url,
    auth: body.auth,
    enabled: body.enabled ?? true,
  });
  getRegistry().scheduleReload();
  res.status(201).json({ server });
});

router.put('/mcp/servers/:id', (req: Request, res: Response) => {
  const id = String(req.params['id']);
  const patch = req.body as Partial<Omit<McpServerConfig, 'id'>>;
  const ok = updateMcpServer(id, patch);
  if (!ok) {
    res.status(404).json({ error: 'server not found' });
    return;
  }
  getRegistry().scheduleReload();
  const servers = getMcpServers();
  const updated = servers.find((s) => s.id === id);
  res.json({ server: updated });
});

router.delete('/mcp/servers/:id', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  await getRegistry().disconnectServer(id);
  const ok = removeMcpServer(id);
  if (!ok) {
    res.status(404).json({ error: 'server not found' });
    return;
  }
  res.json({ ok: true });
});

router.post('/mcp/servers/:id/test', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  const servers = getMcpServers();
  const config = servers.find((s) => s.id === id);
  if (!config) {
    res.status(404).json({ error: 'server not found' });
    return;
  }
  const probe = new McpConnection(config);
  try {
    const toolCount = await probe.probe();
    await probe.disconnect();
    res.json({ ok: true, toolCount });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await probe.disconnect().catch(() => undefined);
    res.json({ ok: false, error });
  }
});

// ---- Profiles ---------------------------------------------------------------

router.get('/mcp/profiles', (_req: Request, res: Response) => {
  res.json({ profiles: getMcpProfiles() });
});

router.put('/mcp/profiles/:name', (req: Request, res: Response) => {
  const name = String(req.params['name']);
  const profile = req.body;
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    res.status(400).json({ error: 'body must be a Profile object' });
    return;
  }
  upsertMcpProfile(name, profile);
  getRegistry().scheduleReload();
  res.json({ name, profile });
});

export default router;
