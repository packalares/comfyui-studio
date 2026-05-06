// Unit tests for McpConnection.
//
// We mock the MCP SDK transport classes so no subprocess or HTTP is involved.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { McpServerConfig } from '../../src/services/settings.mcp.js';

// ---- Transport mock factory -----------------------------------------------

function makeTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((e: Error) => void) | undefined,
    onmessage: undefined as ((m: unknown) => void) | undefined,
  };
}

const mockTransport = makeTransport();

// ---- Client mock -----------------------------------------------------------

const mockTools = [
  { name: 'tool_a', description: 'Tool A', inputSchema: { type: 'object', properties: {} } },
];

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({ tools: mockTools }),
  callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = mockClient.connect;
    close = mockClient.close;
    listTools = mockClient.listTools;
    callTool = mockClient.callTool;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioTransport {
    start = mockTransport.start;
    close = mockTransport.close;
    send = mockTransport.send;
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockHTTPTransport {
    constructor(
      public readonly url: URL,
      public readonly opts?: unknown,
    ) {}
    start = mockTransport.start;
    close = mockTransport.close;
    send = mockTransport.send;
  },
}));

// Import AFTER mocks
const { McpConnection } = await import('../../src/services/mcp/client/connection.js');

// ---- Fixtures --------------------------------------------------------------

const stdioConfig: McpServerConfig = {
  id: 'test-stdio',
  name: 'TestStdio',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'test-mcp'],
  enabled: true,
};

const httpConfig: McpServerConfig = {
  id: 'test-http',
  name: 'TestHTTP',
  transport: 'http',
  url: 'https://example.com/mcp',
  enabled: true,
};

// ---- Tests -----------------------------------------------------------------

describe('McpConnection (stdio)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({ tools: mockTools });
  });

  it('connects and reports connected status', async () => {
    const conn = new McpConnection(stdioConfig);
    await conn.connect();
    expect(conn.status).toBe('connected');
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('listTools returns cached tools after first call', async () => {
    const conn = new McpConnection(stdioConfig);
    await conn.connect();
    const first = await conn.listTools();
    const second = await conn.listTools();
    expect(first).toBe(second); // same reference = cache hit
    expect(mockClient.listTools).toHaveBeenCalledTimes(1);
  });

  it('cache is invalidated on reconnect', async () => {
    const conn = new McpConnection(stdioConfig);
    await conn.connect();
    await conn.listTools();
    await conn.connect(); // reconnect
    await conn.listTools();
    expect(mockClient.listTools).toHaveBeenCalledTimes(2);
  });

  it('disconnect sets status to disconnected', async () => {
    const conn = new McpConnection(stdioConfig);
    await conn.connect();
    await conn.disconnect();
    expect(conn.status).toBe('disconnected');
  });

  it('probe returns tool count', async () => {
    const conn = new McpConnection(stdioConfig);
    const count = await conn.probe();
    expect(count).toBe(mockTools.length);
  });

  it('marks error status when connect fails', async () => {
    mockClient.connect.mockRejectedValueOnce(new Error('refused'));
    const conn = new McpConnection(stdioConfig);
    await expect(conn.connect()).rejects.toThrow('refused');
    expect(conn.status).toBe('error');
    expect(conn.lastError).toContain('refused');
  });
});

describe('McpConnection (http)', () => {
  it('uses StreamableHTTPClientTransport for http transport', async () => {
    // Verify connection succeeds with http config
    const conn = new McpConnection(httpConfig);
    await conn.connect();
    expect(conn.status).toBe('connected');
  });

  it('adds Bearer header for bearer auth', async () => {
    const authConfig: McpServerConfig = {
      ...httpConfig,
      auth: { type: 'bearer', token: 'tok-abc' },
    };
    // Patch _buildTransport to capture the transport instance
    const conn = new McpConnection(authConfig);
    // Access the internal transport after connect
    await conn.connect();
    // Reach into the connection internals via the private field via type cast
    const transport = (conn as unknown as { transport: { url: URL; opts: { requestInit: { headers: Record<string, string> } } } }).transport;
    expect(transport.opts?.requestInit?.headers?.['Authorization']).toBe('Bearer tok-abc');
  });
});
