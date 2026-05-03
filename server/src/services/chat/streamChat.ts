// Streaming chat service. Talks Ollama's native `/api/chat` NDJSON endpoint
// (richer telemetry than the OpenAI shim) and bridges its frames onto the
// Studio WS bus. Lifecycle: persist user msg + placeholder assistant row,
// run strategy enforcement (Phase F), stream chunks via the broadcaster,
// then stamp telemetry on the row on `done`. Aborts cut the upstream
// request by hitting the registered AbortController in `inFlight`.

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
import { getEnabledTools, filterEnabledTools } from './tools/index.js';
import { toOllamaTools, executeOllamaToolCall } from './ollamaTools.js';
import { runToolDispatch, type ToolPart } from './toolDispatch.js';
import { ThinkParser } from './thinkParser.js';
import { enforceContextStrategy } from './contextEnforce.js';

// `LOADING_HINT_MS` and `MAX_TOOL_STEPS` are now `settings.chatLoadingHintMs`
// and `settings.chatMaxToolSteps`. Resolved at call sites below.

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
  /** Optional allow-list of tool names the user has enabled in the composer.
   *  null/undefined = use every configured tool (legacy behavior). */
  enabledToolFilter?: readonly string[] | null;
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
  const toolFilter = input.enabledToolFilter ?? null;
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
    enabledToolFilter: toolFilter,
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
  enabledToolFilter: readonly string[] | null;
}

async function runStream(args: RunStreamArgs): Promise<void> {
  const {
    msgId, conversationId, baseUrl, model, keepAlive,
    abort, messages, systemPrompt, enabledToolFilter,
  } = args;
  const startedAt = Date.now();
  const tracker = { firstTokenAt: 0 };
  let accumulated = '';
  let reasoning = '';
  let finalFrame: OllamaFinalFrame | null = null;
  const toolParts: ToolPart[] = [];

  // Splits `<think>...</think>` segments out of the raw delta stream so we
  // can route the chain-of-thought to a separate `chat:reasoning` channel.
  // Models that don't emit think-tags pass through unchanged.
  const thinkParser = new ThinkParser({
    onContent: (delta) => {
      accumulated += delta;
      emitChatEvent({ type: 'chat:chunk', data: { msgId, delta } });
    },
    onReasoning: (delta) => {
      reasoning += delta;
      emitChatEvent({ type: 'chat:reasoning', data: { msgId, delta } });
    },
  });

  // If no chunk lands within LOADING_HINT_MS, surface a "loading model" hint
  // so the UI explains the long pause on a cold-start. Cleared as soon as
  // the first token arrives, or when the run errors / aborts.
  const loadingTimer = setTimeout(() => {
    if (tracker.firstTokenAt === 0) {
      emitChatEvent({
        type: 'chat:status',
        // Status code, not literal — the UI maps `loading_model` to its
        // displayed phrase so the string only lives in one place. See
        // `ui/src/components/chat/MessageThread.tsx:ColdLoadLoader`.
        data: { msgId, code: 'loading_model' },
      });
    }
  }, settings.getChatLoadingHintMs());

  try {
    let ollamaMessages: OllamaChatMessage[] = convertToOllamaMessages(messages, systemPrompt);
    ollamaMessages = await enforceContextStrategy({
      conversationId, model, baseUrl,
      pendingUserText: lastUserText(messages),
      messages: ollamaMessages,
      msgId,
    });
    const enabledTools = filterEnabledTools(getEnabledTools(), enabledToolFilter);
    const ollamaTools = Object.keys(enabledTools).length > 0
      ? await toOllamaTools(enabledTools)
      : [];

    const dispatch = await runToolDispatch({
      maxSteps: settings.getChatMaxToolSteps(),
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
          thinkParser.feed(delta);
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
    thinkParser.flush();

    const totalMs = Date.now() - startedAt;
    const ttft = tracker.firstTokenAt > 0 ? tracker.firstTokenAt - startedAt : null;
    const stats = finalFrame ? summarizeFinalFrame(finalFrame) : null;

    repo.updateMessageParts(msgId, JSON.stringify(
      ThinkParser.composeAssistantParts(toolParts, reasoning, accumulated),
    ));
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
    thinkParser.flush();
    if (accumulated.length > 0 || reasoning.length > 0 || toolParts.length > 0) {
      repo.updateMessageParts(msgId, JSON.stringify(
        ThinkParser.composeAssistantParts(toolParts, reasoning, accumulated),
      ));
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
