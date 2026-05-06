// McpClientRegistry: boot-time connection manager for all enabled MCP servers.
//
// Lifecycle:
//  - `boot()`: reads settings, connects each enabled server.
//  - `reload()`: debounced 500ms; called by settings writes to reconnect.
//  - `disconnect(id)`: removes one server, cleans up its connection.
//  - `getAllTools()`: merges namespaced tool maps from all connected servers.
//  - process 'exit' / 'SIGINT' / 'SIGTERM': closes all connections.

import { McpConnection, type ConnectionState } from './connection.js';
import { wrapServerTools, type McpToolExecutor } from './wrap.js';
import type { StudioTool } from '../../chat/tools/defineTool.js';
import { getMcpServers } from '../../settings.mcp.js';
import type { McpServerConfig } from '../../settings.mcp.js';
import { logger } from '../../../lib/logger.js';

export class McpClientRegistry {
  private connections = new Map<string, McpConnection>();
  private toolCache = new Map<string, Record<string, StudioTool>>();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- Boot / reload -------------------------------------------------------

  async boot(): Promise<void> {
    const servers = getMcpServers().filter((s) => s.enabled);
    await Promise.allSettled(servers.map((s) => this._connectServer(s)));
    this._registerShutdown();
  }

  /** Schedule a debounced reload (500ms). Multiple calls coalesce. */
  scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this._reload();
    }, 500);
  }

  private async _reload(): Promise<void> {
    const servers = getMcpServers();
    const configIds = new Set(servers.filter((s) => s.enabled).map((s) => s.id));
    // Disconnect removed / disabled servers
    for (const id of this.connections.keys()) {
      if (!configIds.has(id)) await this._disconnectServer(id);
    }
    // Connect / reconnect enabled servers
    await Promise.allSettled(
      servers.filter((s) => s.enabled).map((s) => this._connectServer(s)),
    );
  }

  // ---- Connection management -----------------------------------------------

  private async _connectServer(config: McpServerConfig): Promise<void> {
    // Disconnect existing if any (e.g. reconnect on settings change)
    await this._disconnectServer(config.id);
    const conn = new McpConnection(config);
    this.connections.set(config.id, conn);
    try {
      await conn.connect();
      logger.info(`mcp: connected ${config.name} (${config.id})`);
    } catch (err) {
      logger.warn(`mcp: failed to connect ${config.name}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async disconnectServer(id: string): Promise<void> {
    await this._disconnectServer(id);
  }

  private async _disconnectServer(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    await conn.disconnect();
    this.connections.delete(id);
    this.toolCache.delete(id);
  }

  // ---- Tool aggregation ----------------------------------------------------

  async getAllTools(): Promise<Record<string, StudioTool>> {
    const out: Record<string, StudioTool> = {};
    for (const [id, conn] of this.connections.entries()) {
      if (conn.status !== 'connected') continue;
      // Build executor bound to this connection
      const executor: McpToolExecutor = (toolName, args) =>
        conn.callTool(toolName, args);
      try {
        const tools = await conn.listTools();
        const wrapped = wrapServerTools(id, tools, executor);
        Object.assign(out, wrapped);
      } catch {
        // Server went away — skip its tools silently
      }
    }
    return out;
  }

  // ---- Status --------------------------------------------------------------

  getServerStates(): Array<McpServerConfig & { state: ConnectionState }> {
    const servers = getMcpServers();
    return servers.map((s) => {
      const conn = this.connections.get(s.id);
      const state: ConnectionState = conn
        ? conn.getState()
        : { status: 'disconnected', toolCount: 0 };
      return { ...s, state };
    });
  }

  getConnection(id: string): McpConnection | undefined {
    return this.connections.get(id);
  }

  // ---- Shutdown ------------------------------------------------------------

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.keys()].map((id) => this._disconnectServer(id)),
    );
  }

  private _registerShutdown(): void {
    const handler = () => void this.closeAll();
    process.once('exit', handler);
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  }
}

let _registry: McpClientRegistry | null = null;

export function getRegistry(): McpClientRegistry {
  if (!_registry) _registry = new McpClientRegistry();
  return _registry;
}
