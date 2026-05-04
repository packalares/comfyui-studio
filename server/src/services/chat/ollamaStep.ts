// One Ollama `/api/chat` round-trip with optional tools. Keeps the streaming
// + NDJSON parsing + token accumulation in one place so the higher-level
// `streamChat.ts` can stay focused on lifecycle (persist / abort / WS-emit /
// telemetry rollup).
//
// Returns the final NDJSON frame, the accumulated assistant text, and any
// `tool_calls` the model emitted on the closing frame. The caller decides
// whether to dispatch the tools and loop.

import type { OllamaChatMessage, OllamaFinalFrame } from './ollamaChat.js';
import { iterateNdjson } from './ollamaChat.js';
import { extractToolCalls, type OllamaToolCall, type OllamaToolDef } from './ollamaTools.js';

export interface OllamaStepInput {
  baseUrl: string;
  model: string;
  keepAlive: string;
  messages: OllamaChatMessage[];
  tools?: OllamaToolDef[];
  abort: AbortController;
  onChunk: (delta: string) => void;
  /** Newer Ollama (0.5+) ships chain-of-thought in a separate `thinking`
   *  field on `message` — distinct from the `<think>...</think>` inline
   *  tags older models embed in `content`. We surface those deltas
   *  through this callback so the streamer can route them straight to
   *  the reasoning channel without going through ThinkParser (which only
   *  handles the inline-tag form). Optional — providers that don't emit
   *  `thinking` simply never trigger it. */
  onReasoningChunk?: (delta: string) => void;
  onFirstChunk?: () => void;
  /** Optional per-conversation context-window override. When set we send
   *  `options.num_ctx` so Ollama allocates the requested KV-cache for this
   *  request — without it Ollama falls back to its built-in default
   *  (typically 2048). Capped upstream against the model's published max
   *  before we ever get here. */
  numCtx?: number;
  /** Per-conversation reasoning-mode override. `'on'` → request body
   *  carries `think: true` (force chain-of-thought emission); `'off'` →
   *  `think: false` (skip reasoning, much faster + cheaper); `undefined`
   *  → field omitted, model default applies. */
  thinkMode?: 'on' | 'off';
  /** Sampling temperature override → `options.temperature`. Undefined →
   *  Ollama default (~0.8). The PATCH route clamps to [0, 2] before this
   *  ever sees the value, so no defensive clamp here. */
  temperature?: number;
  /** Output format → top-level `format` field on /api/chat. Currently
   *  only `'json'` is meaningful; future Ollama versions may support a
   *  full JSON Schema object — when they do we'll widen the type. */
  format?: 'json';
}

export interface OllamaStepResult {
  accumulated: string;
  finalFrame: OllamaFinalFrame | null;
  toolCalls: OllamaToolCall[];
}

export async function runOllamaStep(input: OllamaStepInput): Promise<OllamaStepResult> {
  // Streaming with tools is well-supported by recent Ollama (0.4+); older
  // builds force `stream: false` when `tools` is set, in which case we still
  // get a single final NDJSON frame and the loop below treats it the same.
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    stream: true,
    keep_alive: input.keepAlive,
  };
  if (input.tools && input.tools.length > 0) body.tools = input.tools;
  if (input.numCtx && input.numCtx > 0) {
    body.options = { ...(body.options as object | undefined), num_ctx: input.numCtx };
  }
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    body.options = { ...(body.options as object | undefined), temperature: input.temperature };
  }
  if (input.thinkMode === 'on') body.think = true;
  else if (input.thinkMode === 'off') body.think = false;
  if (input.format === 'json') body.format = 'json';

  const res = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: input.abort.signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(
      `ollama /api/chat ${res.status} ${res.statusText}`
      + (detail ? ': ' + detail.slice(0, 240) : ''),
    );
  }

  let firstChunkSeen = false;
  let accumulated = '';
  let finalFrame: OllamaFinalFrame | null = null;
  let toolCalls: OllamaToolCall[] = [];

  for await (const obj of iterateNdjson(res.body)) {
    if (!obj || typeof obj !== 'object') continue;
    const frame = obj as Record<string, unknown> & OllamaFinalFrame;
    if (typeof frame.error === 'string') throw new Error(frame.error);
    const message = frame.message as { content?: string; thinking?: string } | undefined;
    const delta = typeof message?.content === 'string' ? message.content : '';
    const thinkingDelta = typeof message?.thinking === 'string' ? message.thinking : '';
    if (thinkingDelta.length > 0) {
      // Reasoning deltas count as "first activity" too — they arrive before
      // visible content on thinking-mode models, so without this the
      // loading hint would stay up the whole time the model is reasoning.
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (input.onFirstChunk) input.onFirstChunk();
      }
      input.onReasoningChunk?.(thinkingDelta);
    }
    if (delta.length > 0) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (input.onFirstChunk) input.onFirstChunk();
      }
      accumulated += delta;
      input.onChunk(delta);
    }
    // Ollama streams the `tool_calls` payload on a `done: false` frame
    // *before* the closing telemetry frame (verified against llama3.1:latest +
    // mistral-nemo: frame 1 carries the call, frame 2 has done:true but no
    // tool_calls). Extracting only on the final frame loses every tool call
    // when streaming is on. Pull from every frame; the last non-empty wins.
    const calls = extractToolCalls(frame);
    if (calls.length > 0) toolCalls = calls;
    if (frame.done === true) {
      finalFrame = frame;
      break;
    }
  }

  return { accumulated, finalFrame, toolCalls };
}
