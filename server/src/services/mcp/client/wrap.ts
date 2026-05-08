// Convert an MCP tool descriptor (from `tools/list`) into a StudioTool.
//
// Namespaced tool name: `mcp__<serverSlug>__<toolName>` where `serverSlug`
// is derived from the user-given server name (see `slugifyServerName`).
// Stable, hand-writable slugs let users edit `enabledMcpTools` without
// looking up server UUIDs. Slug collisions are rejected at write time.
//
// inputSchema is derived from the MCP tool's JSON-Schema inputSchema via
// `jsonSchemaToZod`.
// The execute function forwards the call to the MCP client; the caller
// provides an `executor` callback to decouple wrap.ts from McpConnection.

import { z } from 'zod';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { defineTool, type StudioTool } from '../../chat/tools/defineTool.js';
import { persistInlineMediaInResult } from '../../chat/toolMediaPersist.js';
import { jsonSchemaToZod } from '../shared/schema.js';

export type McpToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Tool names ship to inference servers as JSON-Schema function names.
 * The schema spec allows letters, digits, `_` and `-`, but several model
 * families (notably gpt-oss / Harmony) rewrite hyphens to underscores
 * when emitting `tool_calls`, breaking round-trip lookup. Normalise both
 * the slug and the tool name to underscores at the boundary so the key
 * the model echoes back matches the key in our tool map exactly. The
 * upstream MCP call still uses the original (hyphenated) name — see
 * `wrapMcpTool` where the executor closes over `mcpTool.name`.
 */
function sanitizeFunctionNameSegment(s: string): string {
  return s.replace(/-/g, '_');
}

/**
 * Namespace a raw MCP tool name for Studio's tool map.
 * Result: `mcp__<serverSlug>__<toolName>` with hyphens normalised.
 */
export function namespacedToolName(serverSlug: string, toolName: string): string {
  return `mcp__${sanitizeFunctionNameSegment(serverSlug)}__${sanitizeFunctionNameSegment(toolName)}`;
}

/**
 * Wrap a single MCP tool descriptor as a StudioTool.
 *
 * @param mcpTool   - Raw tool descriptor from `tools/list`.
 * @param executor  - Callback that calls the tool on the live MCP connection.
 */
export function wrapMcpTool(
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
    execute: async (
      args: Record<string, unknown>,
      opts?: { toolCallId?: string; conversationId?: string; messageId?: string },
    ): Promise<unknown> => {
      try {
        const raw = await executor(mcpTool.name, args ?? {});
        // Inline binary content (screenshots, PDFs, etc.) is persisted into
        // chat_attachments — the tool result the model sees is a small URL
        // string instead of a multi-megabyte base64 blob. We require both
        // `conversationId` and `messageId` to attribute the row correctly;
        // if either is missing (external MCP caller without chat context),
        // skip persistence and return the raw result unchanged.
        if (!opts?.conversationId || !opts?.messageId) return raw;
        return persistInlineMediaInResult(raw, {
          conversationId: opts.conversationId,
          messageId: opts.messageId,
          toolCallId: opts.toolCallId,
        });
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
 * @param serverSlug - Slug derived from the server's user-given name.
 * @param tools      - All tools returned by `tools/list` for this server.
 * @param executor   - Live call-through to the MCP connection.
 */
export function wrapServerTools(
  serverSlug: string,
  tools: McpTool[],
  executor: McpToolExecutor,
): Record<string, StudioTool> {
  const out: Record<string, StudioTool> = {};
  for (const t of tools) {
    const key = namespacedToolName(serverSlug, t.name);
    out[key] = wrapMcpTool(t, executor);
  }
  return out;
}
