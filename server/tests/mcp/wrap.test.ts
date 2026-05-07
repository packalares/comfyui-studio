// wrap.ts: schema translation happy path + $ref case.

import { describe, expect, it, vi } from 'vitest';
import { wrapMcpTool, namespacedToolName } from '../../src/services/mcp/client/wrap.js';
import { jsonSchemaToZod } from '../../src/services/mcp/shared/schema.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

// ---- namespacedToolName ---------------------------------------------------

describe('namespacedToolName', () => {
  it('produces mcp__<serverSlug>__<toolName> with hyphens normalised to underscores', () => {
    // Hyphens in MCP tool names round-trip badly through gpt-oss / Harmony,
    // so we ship underscored names to inference servers. The upstream MCP
    // call still uses the original tool name (see wrapMcpTool's executor).
    expect(namespacedToolName('context7', 'resolve-library-id')).toBe(
      'mcp__context7__resolve_library_id',
    );
  });

  it('normalises hyphens in the slug too', () => {
    expect(namespacedToolName('context-7', 'a-b-c')).toBe('mcp__context_7__a_b_c');
  });

  it('passes through already-underscored names unchanged', () => {
    expect(namespacedToolName('studio', 'remember')).toBe('mcp__studio__remember');
  });
});

// ---- jsonSchemaToZod ------------------------------------------------------

describe('jsonSchemaToZod', () => {
  it('converts a simple object schema to z.object', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max: { type: 'number' },
      },
      required: ['query'],
    };
    const zod = jsonSchemaToZod(schema);
    const ok = zod.safeParse({ query: 'hello' });
    expect(ok.success).toBe(true);
    const fail = zod.safeParse({});
    // query is required
    expect(fail.success).toBe(false);
  });

  it('handles $ref flattening from $defs', () => {
    const schema = {
      type: 'object',
      $defs: {
        Item: { type: 'string' },
      },
      properties: {
        value: { $ref: '#/$defs/Item' },
      },
      required: ['value'],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.safeParse({ value: 'hello' }).success).toBe(true);
    expect(zod.safeParse({ value: 42 }).success).toBe(false);
  });

  it('returns passthrough object for null/empty input', () => {
    const zod = jsonSchemaToZod(null);
    expect(zod.safeParse({}).success).toBe(true);
    expect(zod.safeParse({ anything: true }).success).toBe(true);
  });

  it('handles nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          properties: { active: { type: 'boolean' } },
          required: ['active'],
        },
      },
      required: ['filters'],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.safeParse({ filters: { active: true } }).success).toBe(true);
    expect(zod.safeParse({ filters: {} }).success).toBe(false);
  });

  it('handles array types', () => {
    const schema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.safeParse({ tags: ['a', 'b'] }).success).toBe(true);
    expect(zod.safeParse({ tags: 'not-array' }).success).toBe(false);
  });
});

// ---- wrapMcpTool ----------------------------------------------------------

describe('wrapMcpTool', () => {
  const mcpTool: McpTool = {
    name: 'search',
    description: 'Searches the web',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };

  it('returns a StudioTool with unloadGpuOnUse false', () => {
    const executor = vi.fn().mockResolvedValue('result');
    const studioTool = wrapMcpTool(mcpTool, executor);
    expect(studioTool.unloadGpuOnUse).toBe(false);
    expect(studioTool.tool).toBeDefined();
  });

  it('execute forwards args to executor', async () => {
    const executor = vi.fn().mockResolvedValue('found');
    const studioTool = wrapMcpTool(mcpTool, executor);
    const result = await studioTool.tool.execute!({ query: 'hello' }, {} as never);
    expect(executor).toHaveBeenCalledWith('search', { query: 'hello' });
    expect(result).toBe('found');
  });

  it('execute returns error string on executor failure', async () => {
    const executor = vi.fn().mockRejectedValue(new Error('timeout'));
    const studioTool = wrapMcpTool(mcpTool, executor);
    const result = await studioTool.tool.execute!({ query: 'hi' }, {} as never);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('timeout');
  });
});
