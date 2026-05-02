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
  onFirstChunk?: () => void;
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
    const message = frame.message as { content?: string } | undefined;
    const delta = typeof message?.content === 'string' ? message.content : '';
    if (delta.length > 0) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        if (input.onFirstChunk) input.onFirstChunk();
      }
      accumulated += delta;
      input.onChunk(delta);
    }
    if (frame.done === true) {
      finalFrame = frame;
      const calls = extractToolCalls(frame);
      if (calls.length > 0) toolCalls = calls;
      break;
    }
  }

  return { accumulated, finalFrame, toolCalls };
}
