// Zod schemas for /api/llm/chat, /api/llm/generate, and /api/llm/embeddings.
// These routes stream NDJSON byte-for-byte from Ollama; body schemas do
// minimal sanity-checking before proxying. Response schemas model one NDJSON
// event line (used for OpenAPI metadata only — runtime sends raw bytes).
// Full Ollama wire format: https://github.com/ollama/ollama/blob/main/docs/api.md

import { z } from 'zod';

// Shared message shape (Ollama-native).
const OllamaMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  images: z.array(z.string()).optional(),
  tool_call_id: z.string().optional(),
});

export const LlmChatBodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(OllamaMessageSchema).min(1),
  stream: z.boolean().optional().default(true),
  tools: z.array(z.unknown()).optional(),
  format: z.unknown().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  keep_alive: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const LlmGenerateBodySchema = z.object({
  model: z.string().min(1),
  prompt: z.string(),
  stream: z.boolean().optional().default(true),
  format: z.unknown().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  keep_alive: z.union([z.string(), z.number()]).optional(),
}).passthrough();

export const LlmEmbeddingsBodySchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
  options: z.record(z.string(), z.unknown()).optional(),
  keep_alive: z.union([z.string(), z.number()]).optional(),
}).passthrough();

// ---- Response schemas (one NDJSON event line per endpoint) ----

// One token event from /api/chat
export const LlmChatEventSchema = z.object({
  model: z.string(),
  created_at: z.string(),
  message: z.object({ role: z.string(), content: z.string() }),
  done: z.boolean(),
  done_reason: z.string().optional(),
});

// One token event from /api/generate
export const LlmGenerateEventSchema = z.object({
  model: z.string(),
  created_at: z.string(),
  response: z.string(),
  done: z.boolean(),
  done_reason: z.string().optional(),
});

// Single-shot JSON response from /api/embeddings
export const LlmEmbeddingsResponseSchema = z.object({
  model: z.string(),
  embeddings: z.array(z.array(z.number())),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
});
