// Convert an MCP tool descriptor (from `tools/list`) into a StudioTool.
//
// Namespaced tool name: `mcp__<serverId>__<toolName>`.
// inputSchema is derived from the MCP tool's JSON-Schema inputSchema via
// `jsonSchemaToZod`.
// The execute function forwards the call to the MCP client; the caller
// provides an `executor` callback to decouple wrap.ts from McpConnection.

import { z } from 'zod';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { defineTool, type StudioTool } from '../../chat/tools/defineTool.js';
import { jsonSchemaToZod } from '../shared/schema.js';

export type McpToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Namespace a raw MCP tool name for Studio's tool map.
 * Result: `mcp__<serverId>__<toolName>`.
 */
export function namespacedToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/**
 * Wrap a single MCP tool descriptor as a StudioTool.
 *
 * @param serverId  - The McpServerConfig id (used for namespacing).
 * @param mcpTool   - Raw tool descriptor from `tools/list`.
 * @param executor  - Callback that calls the tool on the live MCP connection.
 */
export function wrapMcpTool(
  serverId: string,
  mcpTool: McpTool,
  executor: McpToolExecutor,
): StudioTool {
  // AI SDK `tool()` needs `FlexibleSchema<Record<string, unknown>>`. The
  // runtime type from jsonSchemaToZod is always a Zod object but the static
  // type is wider — cast via intermediate `as z.ZodType<Record<string, unknown>>`
  // so the AI SDK generic resolves to Record<string, unknown> at the call site.
  const inputSchema = jsonSchemaToZod(mcpTool.inputSchema) as z.ZodType<Record<string, unknown>>;

  return defineTool({
    description: mcpTool.description ?? mcpTool.name,
    inputSchema,
    unloadGpuOnUse: false,
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      try {
        return await executor(mcpTool.name, args ?? {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `mcp tool error (${mcpTool.name}): ${msg}`;
      }
    },
  });
}

/**
 * Convert all tools from one MCP server into a namespaced StudioTool map.
 *
 * @param serverId - The McpServerConfig id.
 * @param tools    - All tools returned by `tools/list` for this server.
 * @param executor - Live call-through to the MCP connection.
 */
export function wrapServerTools(
  serverId: string,
  tools: McpTool[],
  executor: McpToolExecutor,
): Record<string, StudioTool> {
  const out: Record<string, StudioTool> = {};
  for (const t of tools) {
    const key = namespacedToolName(serverId, t.name);
    out[key] = wrapMcpTool(serverId, t, executor);
  }
  return out;
}
