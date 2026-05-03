// `ChatTransport` adapter that bridges Vercel AI SDK's `useChat` hook to
// Studio's existing `/api/chat/start` POST + WebSocket event bus
// (`chatEvents`). The transport is the only piece of frontend glue introduced
// in Phase E; backend wire shapes (streamChat.ts, ollamaChat.ts, the chat
// envelopes) stay byte-for-byte identical.
//
// Lifecycle of a single send:
//   1. `sendMessages` is invoked by `useChat` with the conversation history.
//      The trailing user message we just pushed via `sendMessage` is the
//      last entry; everything before it is the server's source of truth.
//   2. We POST to `/api/chat/start` to obtain the assistant `msgId` (server
//      generates it; we have no say). The server now begins streaming chunks
//      under that id.
//   3. We open a `ReadableStream<UIMessageChunk>` and subscribe to the bus
//      filtered to that `msgId`. Each Studio envelope is translated to one
//      `UIMessageChunk` and enqueued on the stream.
//   4. `chat:done` closes the stream after emitting a `finish` chunk that
//      carries the telemetry stats as `messageMetadata` so the UI can render
//      the `<TelemetryFooter>` from `message.metadata`.
//   5. `abortSignal.abort()` (triggered by `useChat.stop()`) calls
//      `/api/chat/stop/:msgId` and closes the stream.
//
// Studio doesn't support resumable streams — we return `null` from
// `reconnectToStream` and rely on `useChat`'s `resume: false` default.
//
// Ids: `useChat` generates a *user* message id client-side; we rely on the
// server-generated assistant `msgId` and emit it via the `start` chunk's
// `messageId` so the assistant `UIMessage` ends up keyed on the same id the
// rest of Studio's persistence uses (so persisted-history reload + the
// streamed in-flight message are not duplicated).

import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { api } from '../../services/comfyui';
import { chatEvents } from '../../services/chatEvents';
import { uiMessageToWire } from './studioMessages';
import type { StudioUIMessage } from './studioMessages';

interface TransportOptions {
  /** Mutable ref to the active conversation id so the transport always reads
   *  the latest value without a recreate-on-change. `undefined` means "new
   *  conversation"; the server creates it and returns the id on `/chat/start`. */
  conversationIdRef: { current: string | null };
  /** Mutable ref to the model name. Same reasoning as `conversationIdRef`. */
  modelRef: { current: string };
  /** Mutable ref to the user's tools allow-list (composer Tools popover).
   *  `null` means "no filter — use every configured tool". */
  enabledToolsRef: { current: string[] | null };
  /** Called whenever `/chat/start` returns a fresh `conversationId` so the
   *  page can update its state + sidebar. The server may either echo the
   *  caller-provided id or mint a new one (first send in a new chat). */
  onConversationStarted: (conversationId: string, msgId: string) => void;
}

export class StudioTransport implements ChatTransport<StudioUIMessage> {
  constructor(private readonly opts: TransportOptions) {}

  async sendMessages(args: {
    chatId: string;
    messages: StudioUIMessage[];
    abortSignal: AbortSignal | undefined;
    trigger: 'submit-message' | 'regenerate-message';
    messageId: string | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const { messages, abortSignal, trigger } = args;

    // For a regenerate, `useChat` has already trimmed the conversation back
    // to (and including) the user message it wants regenerated; `messages`
    // therefore ends with that user message either way. The server creates
    // a fresh `msgId` for the new assistant turn; the client-side AI SDK
    // doesn't ship branch tracking, so a regenerate just appends.
    void trigger;

    const wireMessages = messages.map(uiMessageToWire);
    const start = await api.chat.start({
      conversationId: this.opts.conversationIdRef.current ?? undefined,
      model: this.opts.modelRef.current,
      messages: wireMessages,
      enabledTools: this.opts.enabledToolsRef.current,
    });

    const conversationId = start.conversationId;
    const msgId = start.msgId;
    this.opts.onConversationStarted(conversationId, msgId);

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let textOpen = false;
        let reasoningOpen = false;
        const cleanups: Array<() => void> = [];

        // The `start` chunk lets us hand `useChat` the server-generated id,
        // which becomes the assistant `UIMessage.id`. Without this, useChat
        // would mint its own id and we'd have to reconcile two ids on done.
        controller.enqueue({ type: 'start', messageId: msgId });
        controller.enqueue({ type: 'start-step' });

        const ensureTextOpen = () => {
          if (textOpen) return;
          controller.enqueue({ type: 'text-start', id: msgId });
          textOpen = true;
        };
        const ensureReasoningOpen = () => {
          if (reasoningOpen) return;
          controller.enqueue({ type: 'reasoning-start', id: msgId });
          reasoningOpen = true;
        };

        cleanups.push(chatEvents.onChunk(({ msgId: id, delta }) => {
          if (id !== msgId) return;
          ensureTextOpen();
          controller.enqueue({ type: 'text-delta', id: msgId, delta });
        }));

        cleanups.push(chatEvents.onReasoning(({ msgId: id, delta }) => {
          if (id !== msgId) return;
          ensureReasoningOpen();
          controller.enqueue({ type: 'reasoning-delta', id: msgId, delta });
        }));

        cleanups.push(chatEvents.onTool(({ msgId: id, part }) => {
          if (id !== msgId) return;
          // Studio's `chat:tool` envelope is terminal (no streaming-args /
          // running state). Replay it as `input-available` followed by the
          // matching `output-*` chunk. `useChat` reduces the pair into one
          // `dynamic-tool` UI part with `state: 'output-available' |
          // 'output-error'` — exactly what `<Tool>` from ai-elements renders.
          controller.enqueue({
            type: 'tool-input-available',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.args,
            dynamic: true,
          });
          if (part.state === 'error') {
            controller.enqueue({
              type: 'tool-output-error',
              toolCallId: part.toolCallId,
              errorText: part.errorMessage ?? 'Unknown error',
              dynamic: true,
            });
          } else {
            controller.enqueue({
              type: 'tool-output-available',
              toolCallId: part.toolCallId,
              output: part.result,
              dynamic: true,
            });
          }
        }));

        cleanups.push(chatEvents.onDone(({ msgId: id, stats }) => {
          if (id !== msgId) return;
          if (textOpen) controller.enqueue({ type: 'text-end', id: msgId });
          if (reasoningOpen) controller.enqueue({ type: 'reasoning-end', id: msgId });
          controller.enqueue({ type: 'finish-step' });
          controller.enqueue({
            type: 'finish',
            // Telemetry rides on `messageMetadata` so the UI can read it from
            // `message.metadata` regardless of whether the message was just
            // streamed or rehydrated from the DB.
            messageMetadata: {
              tokens_in: stats.tokens_in,
              tokens_out: stats.tokens_out,
              ms_to_first_token: stats.ms_to_first_token,
              ms_total: stats.ms_total,
              tokens_per_sec: stats.tokens_per_sec,
              model: stats.model,
              conversationId,
            },
          });
          controller.close();
          for (const fn of cleanups) fn();
        }));

        cleanups.push(chatEvents.onError(({ msgId: id, error }) => {
          if (id !== msgId) return;
          controller.enqueue({ type: 'error', errorText: error });
          controller.close();
          for (const fn of cleanups) fn();
        }));

        // `chat:status` ("loading model into VRAM..." cold-load hint) has no
        // direct counterpart in the UIMessageChunk schema. We surface it
        // through Studio's existing bus (the page-level `<Loader status>` in
        // `MessageThread` still subscribes for the streaming hint).

        if (abortSignal) {
          if (abortSignal.aborted) {
            void api.chat.stop(msgId).catch(() => { /* swallow */ });
            controller.close();
            for (const fn of cleanups) fn();
          } else {
            abortSignal.addEventListener('abort', () => {
              void api.chat.stop(msgId).catch(() => { /* swallow */ });
              // Don't close the stream here — the server still emits a `done`
              // for the partial response. `chatEvents.onDone` will run the
              // close + cleanup path normally.
            }, { once: true });
          }
        }
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // Studio's WS bus doesn't carry replay state, so a stream that was
    // running when the page reloaded is gone. `useChat` is configured with
    // `resume: false` (the default) so this method is never called in
    // practice; we satisfy the interface defensively.
    return null;
  }
}

// Local re-export to keep call sites tidy.
export type { UIMessage };
