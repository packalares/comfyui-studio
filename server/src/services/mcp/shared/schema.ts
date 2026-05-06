// JSON-Schema -> Zod conversion for MCP tool input schemas.
//
// MCP tools declare their inputs as JSON Schema objects. The AI-SDK `tool()`
// factory needs a Zod schema for validation + OpenAI-compatible serialisation.
// We convert the MCP JSON Schema to a `z.ZodTypeAny` suitable for passing to
// `defineTool()` as `inputSchema`.
//
// $ref flattening: we do one-level inline dereferencing for `$defs` /
// `definitions`. Deeply-nested cycles are left as `z.unknown()` rather than
// blowing the stack.

import { z } from 'zod';

type JsonSchemaNode = Record<string, unknown>;

function resolveRef(
  schema: JsonSchemaNode,
  root: JsonSchemaNode,
  depth: number,
): z.ZodTypeAny {
  if (depth > 8) return z.unknown();
  const ref = schema['$ref'];
  if (typeof ref !== 'string') return convertNode(schema, root, depth);
  // Only handle local refs: #/$defs/Foo or #/definitions/Foo
  const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return z.unknown();
  const name = match[1];
  const defs = (root['$defs'] ?? root['definitions']) as Record<string, unknown> | undefined;
  const target = defs?.[name];
  if (!target || typeof target !== 'object') return z.unknown();
  return convertNode(target as JsonSchemaNode, root, depth + 1);
}

function convertNode(
  schema: JsonSchemaNode,
  root: JsonSchemaNode,
  depth: number,
): z.ZodTypeAny {
  if (depth > 8) return z.unknown();
  if ('$ref' in schema) return resolveRef(schema, root, depth);

  const type = schema['type'];
  const desc = typeof schema['description'] === 'string' ? schema['description'] : undefined;

  // anyOf / oneOf: map to z.union (best-effort)
  const anyOf = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const members = anyOf.map((s: unknown) =>
      convertNode(s as JsonSchemaNode, root, depth + 1),
    ) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
    const u = members.length >= 2 ? z.union(members) : members[0];
    return desc ? u.describe(desc) : u;
  }

  let node: z.ZodTypeAny;

  if (type === 'object') {
    const props = schema['properties'];
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    const shape: Record<string, z.ZodTypeAny> = {};
    if (props && typeof props === 'object') {
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        const child = convertNode(v as JsonSchemaNode, root, depth + 1);
        shape[k] = required.includes(k) ? child : child.optional();
      }
    }
    node = z.object(shape);
  } else if (type === 'array') {
    const items = schema['items'];
    const itemSchema = items && typeof items === 'object'
      ? convertNode(items as JsonSchemaNode, root, depth + 1)
      : z.unknown();
    node = z.array(itemSchema);
  } else if (type === 'string') {
    node = z.string();
  } else if (type === 'number' || type === 'integer') {
    node = z.number();
  } else if (type === 'boolean') {
    node = z.boolean();
  } else if (type === 'null') {
    node = z.null();
  } else {
    node = z.unknown();
  }

  return desc ? node.describe(desc) : node;
}

/**
 * Convert a JSON-Schema object (as returned by `tools/list`) into a Zod schema
 * suitable for `defineTool({ inputSchema: ... })`.
 *
 * Returns `z.object({}).passthrough()` on null/empty input so callers always
 * get a usable Zod object without extra null checks.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.object({}).passthrough();
  }
  const node = schema as JsonSchemaNode;
  if (node['type'] !== 'object' && !('properties' in node)) {
    // Top-level must be an object per MCP spec; wrap anything else
    return z.object({}).passthrough();
  }
  return convertNode(node, node, 0);
}
