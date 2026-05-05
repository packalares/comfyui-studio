// Streaming chat service. Talks Ollama's native `/api/chat` NDJSON endpoint
// (richer telemetry than the OpenAI shim) and bridges its frames onto the
// Studio WS bus. Lifecycle: persist user msg + placeholder assistant row,
// run strategy enforcement (Phase F), stream chunks via the broadcaster,
// then stamp telemetry on the row on `done`. Aborts cut the upstream
// request by hitting the registered AbortController in `inFlight`.
//

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
import { generateSuggestions } from './suggestionGenerator.js';
import { isModelLoaded } from './ollamaPs.js';
import { getEnabledTools, filterEnabledTools, toAiSdkToolMap } from './tools/index.js';
import { toOllamaTools, executeOllamaToolCall } from './ollamaTools.js';
import { runToolDispatch, type ToolPart } from './toolDispatch.js';
import { ThinkParser } from './thinkParser.js';
import { enforceContextStrategy } from './contextEnforce.js';
import { beforeTool as gpuBeforeTool } from './gpuOrchestrator.js';

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
  // Capture the user msg id (when present) so the auto-compact path can
  // preserve it through the destructive write. `null` for regenerate
  // requests where the latest user turn is already in the DB.
  let userMsgId: string | null = null;
  if (lastUser) {
    userMsgId = makeId();
    repo.appendMessage({
      id: userMsgId,
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
    msgId, userMsgId, conversationId, baseUrl, model, keepAlive,
    abort, messages, systemPrompt: systemPrompt ?? null,
    enabledToolFilter: toolFilter,
  });

  return { msgId };
}

interface RunStreamArgs {
  msgId: string;
  /** Id of the just-appended user message — null on regenerate paths
   *  where the user turn was already in the DB. Forwarded to the
   *  context-strategy enforcement so the 'auto' path preserves it. */
  userMsgId: string | null;
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
    msgId, userMsgId, conversationId, baseUrl, model, keepAlive,
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

  // The cold-load hint is gated by two signals so we don't flash the
  // "Loading model into VRAM…" banner on already-resident models:
  //
  //   1. /api/ps precheck — runs on every request. When the model is
  //      already loaded, disarm the timer below so it can't fire later
  //      even if the first token is slow. When it's NOT loaded, emit the
  //      hint immediately (no need to wait 1.5s for the timer fallback).
  //   2. Setup-timer fallback — only fires if the precheck is still
  //      pending (network race) or returned `null` (api/ps failure).
  //
  // The flag is captured by the timer closure so a fast /api/ps response
  // disarms a still-pending timer without needing a clearTimeout race.
  let loadingHintArmed = true;
  void isModelLoaded(baseUrl, model).then((loaded) => {
    if (loaded === true) {
      // Model is already in VRAM — no banner, regardless of first-token speed.
      loadingHintArmed = false;
    } else if (loaded === false && tracker.firstTokenAt === 0) {
      emitChatEvent({
        type: 'chat:status',
        data: { msgId, code: 'loading_model' },
      });
      // Already emitted; let the timer be a no-op so we don't double-fire.
      loadingHintArmed = false;
    }
    // `null` (api/ps unreachable) → leave armed; timer takes over.
  });

  const loadingTimer = setTimeout(() => {
    if (loadingHintArmed && tracker.firstTokenAt === 0) {
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
    // Preserve the just-appended user msg + assistant placeholder through
    // any destructive auto-compact so the in-flight turn keeps working.
    const preserveIds = new Set<string>([msgId]);
    if (userMsgId) preserveIds.add(userMsgId);
    ollamaMessages = await enforceContextStrategy({
      conversationId, model, baseUrl,
      pendingUserText: lastUserText(messages),
      messages: ollamaMessages,
      msgId,
      preserveIds,
    });
    // Per-conversation `num_ctx`. Sent in `options.num_ctx` ONLY when the
    // user has pinned a value via the meter slider. On Auto (NULL) we
    // omit the field entirely so Ollama uses the model's native default
    // — vital for vision models like glm-ocr where the modelfile sets a
    // larger `num_ctx` (e.g. 32K) to fit image tokens; forcing 4K from
    // Studio mismatches the vision tower's tensor shapes.
    // The meter reads the actual allocation from `/api/ps` and uses
    // that as the budget so the percentage stays honest on Auto.
    const conv = repo.getConversation(conversationId);
    const numCtx = conv?.num_ctx ?? undefined;
    const thinkMode = conv?.think_mode ?? undefined;
    const temperature = conv?.temperature ?? undefined;
    const format = conv?.format ?? undefined;
    const enabledTools = filterEnabledTools(getEnabledTools(), enabledToolFilter);
    // Derive an AI-SDK tool map for `toOllamaTools` / `executeOllamaToolCall`
    // — those helpers consume the bare AI-SDK shape, while `enabledTools`
    // also carries the Studio metadata the GPU orchestrator needs.
    const aiSdkTools = toAiSdkToolMap(enabledTools);
    const ollamaTools = Object.keys(aiSdkTools).length > 0
      ? await toOllamaTools(aiSdkTools)
      : [];

    const dispatch = await runToolDispatch({
      maxSteps: settings.getChatMaxToolSteps(),
      enabledTools: aiSdkTools,
      ollamaTools,
      runStep: (msgs) => runOllamaStep({
        baseUrl, model, keepAlive, numCtx, thinkMode, temperature, format,
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
        // New-format thinking lives in `message.thinking` — already a clean
        // reasoning stream, no inline tags to strip. Route straight to the
        // sink that pushes `chat:reasoning` deltas. Mirrors the firstToken
        // bookkeeping so the cold-load hint clears on the first thinking
        // delta even when the visible content stream hasn't started yet.
        onReasoningChunk: (delta) => {
          if (tracker.firstTokenAt === 0) {
            tracker.firstTokenAt = Date.now();
            clearTimeout(loadingTimer);
          }
          reasoning += delta;
          emitChatEvent({ type: 'chat:reasoning', data: { msgId, delta } });
        },
      }),
      executeToolCall: (call) => executeOllamaToolCall(aiSdkTools, call),
      onBeforeTool: async (toolName) => {
        const studioTool = enabledTools[toolName];
        if (!studioTool) return;
        await gpuBeforeTool(studioTool, model, {
          emitStatus: (code, message) => {
            emitChatEvent({
              type: 'chat:status',
              data: { msgId, code, message },
            });
          },
        });
      },
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
      // load_duration from the final NDJSON frame (ns → ms). Round so we
      // don't store noise like 4123.876 ms; integer milliseconds are
      // plenty for "Loaded in 4.1 s" UX. Zero when the model was already
      // resident — Ollama still reports it but as a tiny value.
      load_duration_ms: stats?.ms_load !== null && stats?.ms_load !== undefined
        ? Math.round(stats.ms_load)
        : null,
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
    // Smart suggestions — fire-and-forget. Asks the active model to propose
    // 3 short follow-up prompts; broadcasts them via WS as
    // `chat:suggestions`. Toggled off in Settings → Chat for users on
    // small / metered models who don't want the extra round-trip.
    if (settings.getChatSmartSuggestions()) {
      // Re-resolve num_ctx — same logic as the main chat call. When the
      // conversation is on Auto we omit `options.num_ctx` so Ollama
      // keeps the same allocation it just used for the main reply
      // (KV-cache stays warm; no model reload between turns).
      const post = repo.getConversation(conversationId);
      const postNumCtx = post?.num_ctx ?? undefined;
      void generateSuggestions({ conversationId, model, baseUrl, numCtx: postNumCtx })
        .then((suggestions) => {
          if (suggestions.length === 0) return;
          emitChatEvent({
            type: 'chat:suggestions',
            data: { conversationId, msgId, suggestions },
          });
        })
        .catch((err) => {
          logger.warn('suggestions: post-turn dispatch failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }
}

export function abortStream(msgId: string): boolean {
  const entry = inFlight.get(msgId);
  if (!entry) return false;
  entry.abort.abort();
  inFlight.delete(msgId);
  return true;
}
