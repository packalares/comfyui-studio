// Bridge between Vercel-AI-SDK `tool()` descriptors and Ollama's native
// `tools` parameter on `/api/chat`. The polish agent moved chat off
// `streamText` and onto direct NDJSON, so we feed Ollama the OpenAI-style
// `function` tool shape it accepts and parse `tool_calls` back out of the
// streamed message frames.
//
// Ollama wire shape (verified against
// https://github.com/ollama/ollama/blob/main/docs/api.md#chat-request-with-tools):
//
//   tools: [{
//     type: "function",
//     function: { name, description, parameters: <JSON schema> }
//   }]
//
// On a tool call the streamed final frame returns
//   message: { role: "assistant", content: "", tool_calls: [
//     { function: { name, arguments: { ... } } }
//   ]}

import { asSchema } from 'ai';
import type { JSONSchema7 } from '@ai-sdk/provider';

/** Ollama's `tools[i]` entry. */
export interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JSONSchema7;
  };
}

/** Single `tool_calls` entry surfaced on Ollama's assistant frame. */
export interface OllamaToolCall {
  function: {
    name: string;
    arguments: unknown;
  };
}

interface AiSdkTool {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, opts: unknown) => Promise<unknown> | unknown;
}

function isToolLike(value: unknown): value is AiSdkTool {
  return value !== null && typeof value === 'object'
    && 'inputSchema' in (value as Record<string, unknown>);
}

/**
 * Convert the AI SDK `tool()` descriptor map into Ollama's tool array. The
 * `inputSchema` is a Zod / Standard / JSON-Schema object; `asSchema` from the
 * AI SDK normalizes any of those into a `Schema<T>` whose `jsonSchema` is the
 * JSON Schema we hand to Ollama.
 */
export async function toOllamaTools(
  tools: Record<string, unknown>,
): Promise<OllamaToolDef[]> {
  const out: OllamaToolDef[] = [];
  for (const [name, raw] of Object.entries(tools)) {
    if (!isToolLike(raw)) continue;
    const schema = asSchema(raw.inputSchema as never);
    // `jsonSchema` on the resolved Schema is `JSONSchema7 | PromiseLike<...>`;
    // `await` handles both shapes uniformly.
    const json = await schema.jsonSchema as JSONSchema7;
    out.push({
      type: 'function',
      function: {
        name,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        parameters: json,
      },
    });
  }
  return out;
}

/**
 * Best-effort extraction of `tool_calls` from a streamed Ollama frame. The
 * field is optional and only present on the final assistant frame when the
 * model decided to call a tool.
 */
export function extractToolCalls(frame: unknown): OllamaToolCall[] {
  if (!frame || typeof frame !== 'object') return [];
  const message = (frame as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return [];
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: OllamaToolCall[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const fn = (c as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object') continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) continue;
    const args = (fn as { arguments?: unknown }).arguments;
    out.push({ function: { name, arguments: args } });
  }
  return out;
}

/**
 * Execute a single tool call against the AI-SDK tool descriptor. Catches every
 * failure and returns it as a structured payload — tool errors must NEVER
 * bubble up as exceptions because that aborts the streaming run; the LLM gets
 * a string back so it can react.
 */
export async function executeOllamaToolCall(
  tools: Record<string, unknown>,
  call: OllamaToolCall,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  const t = tools[call.function.name];
  if (!isToolLike(t) || typeof t.execute !== 'function') {
    return { ok: false, error: `unknown tool "${call.function.name}"` };
  }
  // Ollama may serialize `arguments` either as a parsed object or as a JSON
  // string — accept both. The runtime schema validation lives inside each
  // tool's execute via Zod.
  let input: unknown = call.function.arguments;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { /* leave as-is */ }
  }
  try {
    const output = await t.execute(input, { toolCallId: '', messages: [] });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
