// Streaming chat service. Talks directly to Ollama's native `/api/chat`
// NDJSON endpoint (rather than the OpenAI-compatible adapter) so we get
// full per-response telemetry — `eval_count`, `eval_duration`, etc. — and
// can pass `keep_alive` / `tools` / `images` through cleanly. Per-stream
// lifecycle:
//
//   1. Persist the user message synchronously (caller has built it from the
//      incoming UIMessages).
//   2. Insert a placeholder assistant row so /api/chat/conversations/:id/
//      messages can include a partial transcript while streaming.
//   3. Pipe each NDJSON delta to the WS as `chat:chunk` envelopes. When tools
//      are configured, emit `chat:tool` envelopes for each tool invocation.
//   4. On finish: capture telemetry from the final frame, update the row,
//      touch the conversation's `updated_at`, broadcast `chat:done`.
//
// Aborts: each in-flight stream is registered in `inFlight` keyed by
// assistant message id; `abortStream(msgId)` calls the underlying
// AbortController so the upstream HTTP request is cut.

import type { UIMessage } from 'ai';
import { logger } from '../../lib/logger.js';
import * as repo from '../../lib/db/chat.repo.js';
import * as settings from '../settings.js';
import { emitChatEvent } from './broadcaster.js';
import { maybeAutoTitle, lastUserText } from './autoTitle.js';
import {
  convertToOllamaMessages,
  summarizeFinalFrame,
  type OllamaChatMessage,
  type OllamaFinalFrame,
} from './ollamaChat.js';
import { runOllamaStep } from './ollamaStep.js';
import { getEnabledTools } from './tools/index.js';
import { toOllamaTools, executeOllamaToolCall } from './ollamaTools.js';
import { runToolDispatch, type ToolPart } from './toolDispatch.js';

// If no chunk arrives within this many ms after submit, surface a "Loading
// model into VRAM..." status. Picked above typical TTFT (~200-600ms warm)
// and below cold-load (commonly multiple seconds on big models).
const LOADING_HINT_MS = 1500;

// Hard cap on tool-dispatch iterations. Without this a buggy tool-loop could
// monopolize the GPU; the LLM normally wraps up in 1-3 rounds.
const MAX_TOOL_STEPS = 6;

interface InFlight {
  abort: AbortController;
  conversationId: string;
}
const inFlight = new Map<string, InFlight>();

function makeId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export interface StreamChatInput {
  conversationId: string;
  messages: UIMessage[];
  model: string;
  systemPrompt?: string | null;
  keepAlive?: string;
}

export interface StreamChatStarted {
  msgId: string;
}

/**
 * Kick off a streaming chat completion. Returns the assistant message id
 * synchronously; streaming continues in the background and emits chunks
 * over the WS broadcaster. Persists the user message + an empty assistant
 * row before returning so a refetch of /messages always reflects the state
 * the client has already seen on the wire.
 */
export function startStream(input: StreamChatInput): StreamChatStarted {
  const { conversationId, messages, model, systemPrompt } = input;
  const baseUrl = settings.getOllamaUrl();
  const keepAlive = input.keepAlive ?? settings.getChatKeepAlive();
  const now = Date.now();

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (lastUser) {
    const userId = makeId();
    repo.appendMessage({
      id: userId,
      conversation_id: conversationId,
      role: 'user',
      parts: JSON.stringify(lastUser.parts ?? []),
      created_at: now,
    });
  }

  const msgId = makeId();
  repo.appendMessage({
    id: msgId,
    conversation_id: conversationId,
    role: 'assistant',
    parts: JSON.stringify([{ type: 'text', text: '' }]),
    created_at: now + 1,
    telemetry: { model },
  });

  const abort = new AbortController();
  inFlight.set(msgId, { abort, conversationId });

  emitChatEvent({ type: 'chat:start', data: { conversationId, msgId, model } });

  void runStream({
    msgId, conversationId, baseUrl, model, keepAlive,
    abort, messages, systemPrompt: systemPrompt ?? null,
  });

  return { msgId };
}

interface RunStreamArgs {
  msgId: string;
  conversationId: string;
  baseUrl: string;
  model: string;
  keepAlive: string;
  abort: AbortController;
  messages: UIMessage[];
  systemPrompt: string | null;
}

async function runStream(args: RunStreamArgs): Promise<void> {
  const { msgId, conversationId, baseUrl, model, keepAlive, abort, messages, systemPrompt } = args;
  const startedAt = Date.now();
  const tracker = { firstTokenAt: 0 };
  let accumulated = '';
  let finalFrame: OllamaFinalFrame | null = null;
  const toolParts: ToolPart[] = [];

  // If no chunk lands within LOADING_HINT_MS, surface a "loading model" hint
  // so the UI explains the long pause on a cold-start. Cleared as soon as
  // the first token arrives, or when the run errors / aborts.
  const loadingTimer = setTimeout(() => {
    if (tracker.firstTokenAt === 0) {
      emitChatEvent({
        type: 'chat:status',
        data: { msgId, message: 'Loading model into VRAM...' },
      });
    }
  }, LOADING_HINT_MS);

  try {
    const ollamaMessages: OllamaChatMessage[] = convertToOllamaMessages(messages, systemPrompt);
    const enabledTools = getEnabledTools();
    const ollamaTools = Object.keys(enabledTools).length > 0
      ? await toOllamaTools(enabledTools)
      : [];

    const dispatch = await runToolDispatch({
      maxSteps: MAX_TOOL_STEPS,
      enabledTools,
      ollamaTools,
      runStep: (msgs) => runOllamaStep({
        baseUrl, model, keepAlive,
        messages: msgs,
        tools: ollamaTools.length > 0 ? ollamaTools : undefined,
        abort,
        onChunk: (delta) => {
          if (tracker.firstTokenAt === 0) {
            tracker.firstTokenAt = Date.now();
            clearTimeout(loadingTimer);
          }
          accumulated += delta;
          emitChatEvent({ type: 'chat:chunk', data: { msgId, delta } });
        },
      }),
      executeToolCall: (call) => executeOllamaToolCall(enabledTools, call),
      onToolPart: (part) => {
        toolParts.push(part);
        emitChatEvent({ type: 'chat:tool', data: { msgId, part } });
      },
      seedMessages: ollamaMessages,
    });
    finalFrame = dispatch.finalFrame;

    const totalMs = Date.now() - startedAt;
    const ttft = tracker.firstTokenAt > 0 ? tracker.firstTokenAt - startedAt : null;
    const stats = finalFrame ? summarizeFinalFrame(finalFrame) : null;

    const persistedParts: unknown[] = [...toolParts, { type: 'text', text: accumulated }];
    repo.updateMessageParts(msgId, JSON.stringify(persistedParts));
    const telemetry = {
      tokens_in: stats?.tokens_in ?? null,
      tokens_out: stats?.tokens_out ?? null,
      ms_to_first_token: ttft,
      ms_total: totalMs,
      tokens_per_sec: stats?.tokens_per_sec ?? null,
      model,
    };
    repo.updateMessageTelemetry(msgId, telemetry);
    repo.touchConversation(conversationId, Date.now());

    emitChatEvent({ type: 'chat:done', data: { msgId, stats: telemetry } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (accumulated.length > 0 || toolParts.length > 0) {
      const persistedParts: unknown[] = [...toolParts, { type: 'text', text: accumulated }];
      repo.updateMessageParts(msgId, JSON.stringify(persistedParts));
    }
    logger.warn('chat stream failed', { msgId, error: message });
    emitChatEvent({ type: 'chat:error', data: { msgId, error: message } });
  } finally {
    clearTimeout(loadingTimer);
    inFlight.delete(msgId);
  }

  // Best-effort title generation on the FIRST assistant turn only. Skips when
  // the conversation already has a non-default title (set via PATCH or by a
  // prior turn). Runs after the stream completes so it never blocks tokens.
  if (accumulated.length > 0) {
    void maybeAutoTitle({
      conversationId, model, baseUrl,
      userText: lastUserText(messages),
      assistantText: accumulated,
    });
  }
}

export function abortStream(msgId: string): boolean {
  const entry = inFlight.get(msgId);
  if (!entry) return false;
  entry.abort.abort();
  inFlight.delete(msgId);
  return true;
}
