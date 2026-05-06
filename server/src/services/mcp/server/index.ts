// McpServer factory for Studio's built-in MCP endpoint.
// Single entry point — all 16 tools (comfy + studio) come from toolRegistry.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './toolRegistry.js';

export function createStudioMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'studio', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server);
  return server;
}
