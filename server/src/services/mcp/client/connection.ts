// McpConnection: thin lifecycle wrapper around the MCP SDK `Client`.
//
// One instance per configured McpServerConfig entry. Manages:
//   - Spawning a stdio subprocess OR opening a streamable-HTTP session.
//   - `tools/list` cache (invalidated on reconnect).
//   - Status tracking: 'connected' | 'disconnected' | 'error'.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../../../services/settings.mcp.js';
import {
  withTimeout,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../shared/transport.js';

export type ConnectionStatus = 'connected' | 'disconnected' | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  lastError?: string;
  toolCount: number;
}

export class McpConnection {
  private client: Client | null = null;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private toolCache: Tool[] | null = null;

  status: ConnectionStatus = 'disconnected';
  lastError: string | undefined;

  constructor(private readonly config: McpServerConfig) {}

  async connect(): Promise<void> {
    await this.disconnect();
    this.status = 'disconnected';
    this.lastError = undefined;
    this.toolCache = null;

    try {
      const transport = this._buildTransport();
      this.transport = transport;
      this.client = new Client({ name: 'comfyui-studio', version: '1.0.0' });
      await withTimeout(
        this.client.connect(transport),
        DEFAULT_CONNECT_TIMEOUT_MS,
        `connect(${this.config.name})`,
      );
      this.status = 'connected';
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.client = null;
      this.transport = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.toolCache = null;
    if (this.client) {
      try { await this.client.close(); } catch { /* best-effort */ }
      this.client = null;
    }
    if (this.transport) {
      try { await this.transport.close(); } catch { /* best-effort */ }
      this.transport = null;
    }
    if (this.status !== 'error') this.status = 'disconnected';
  }

  async listTools(): Promise<Tool[]> {
    if (this.toolCache) return this.toolCache;
    if (!this.client || this.status !== 'connected') {
      throw new Error(`server ${this.config.name} not connected`);
    }
    const result = await withTimeout(
      this.client.listTools(),
      DEFAULT_REQUEST_TIMEOUT_MS,
      `listTools(${this.config.name})`,
    );
    this.toolCache = result.tools ?? [];
    return this.toolCache;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.client || this.status !== 'connected') {
      throw new Error(`server ${this.config.name} not connected`);
    }
    return withTimeout(
      this.client.callTool({ name, arguments: args }),
      DEFAULT_REQUEST_TIMEOUT_MS,
      `callTool(${name})`,
    );
  }

  /** Test connectivity: connect (if not already), list tools, return count. */
  async probe(): Promise<number> {
    if (this.status !== 'connected') await this.connect();
    const tools = await this.listTools();
    return tools.length;
  }

  getState(): ConnectionState {
    return {
      status: this.status,
      lastError: this.lastError,
      toolCount: this.toolCache?.length ?? 0,
    };
  }

  private _buildTransport() {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) throw new Error('stdio transport requires command');
      return new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        stderr: 'pipe',
      });
    }
    // http
    if (!this.config.url) throw new Error('http transport requires url');
    const headers: Record<string, string> = {};
    if (this.config.auth?.type === 'bearer') {
      headers['Authorization'] = `Bearer ${this.config.auth.token}`;
    }
    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: { headers },
    });
  }
}
