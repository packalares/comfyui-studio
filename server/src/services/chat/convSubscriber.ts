// Per-conversation SSE subscription tap.
//
// The WS broadcaster fires emitChatEvent() for every active stream. This
// module lets SSE clients subscribe to events scoped to one conversation
// without touching the broadcaster or streamChat internals.
//
// Usage:
//   const unsub = subscribeToConvStream(convId, { onChunk, onDone, ... });
//   // later:
//   unsub();

import type {
  ChatChunkPayload,
  ChatReasoningPayload,
  ChatToolPayload,
  ChatStatusPayload,
  ChatDonePayload,
  ChatErrorPayload,
} from './eventPayloads.js';

export interface ConvStreamCallbacks {
  onChunk?: (p: ChatChunkPayload) => void;
  onReasoning?: (p: ChatReasoningPayload) => void;
  onTool?: (p: ChatToolPayload) => void;
  onStatus?: (p: ChatStatusPayload) => void;
  onDone?: (p: ChatDonePayload) => void;
  onError?: (p: ChatErrorPayload) => void;
}

// Module-level registry of active per-conversation SSE listeners.
// Key: conversationId → Set of listener sets.
const listeners = new Map<string, Set<ConvStreamCallbacks>>();

/** Register callbacks for one conversation. Returns an unsubscribe fn. */
export function subscribeToConvStream(
  conversationId: string,
  cbs: ConvStreamCallbacks,
): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(cbs);
  return () => {
    const s = listeners.get(conversationId);
    if (!s) return;
    s.delete(cbs);
    if (s.size === 0) listeners.delete(conversationId);
  };
}

/** Called by the global emitChatEvent shim (see broadcaster.ts integration below).
 *  Routes the event to any SSE subscriber watching `conversationId`. */
export function dispatchToConvSubscribers(type: string, data: Record<string, unknown>): void {
  // All chat events carry a msgId; we need conversationId to scope the stream.
  // `chat:start` carries `conversationId`; for all subsequent events we look
  // up the in-flight map via `msgId → conversationId` (see streamChat.ts).
  // Rather than threading that lookup here, we accept the conversationId on
  // the envelope when present, or skip when not determinable.
  const convId = typeof data.conversationId === 'string' ? data.conversationId : null;
  const msgId = typeof data.msgId === 'string' ? data.msgId : '';

  // For msgId-bearing events the broadcaster shim (in broadcaster.ts) passes
  // the resolved conversationId on the envelope. See setChatBroadcaster in
  // index.ts for the enrichment patch applied at boot.
  if (!convId) return;

  const set = listeners.get(convId);
  if (!set || set.size === 0) return;

  for (const cbs of set) {
    try {
      if (type === 'chat:chunk' && cbs.onChunk) {
        cbs.onChunk({ msgId, delta: String(data.delta ?? '') });
      } else if (type === 'chat:reasoning' && cbs.onReasoning) {
        cbs.onReasoning({ msgId, delta: String(data.delta ?? '') });
      } else if (type === 'chat:tool' && cbs.onTool) {
        cbs.onTool({ msgId, part: data.part as ChatToolPayload['part'] });
      } else if (type === 'chat:status' && cbs.onStatus) {
        cbs.onStatus({
          msgId,
          code: data.code as ChatStatusPayload['code'],
          message: typeof data.message === 'string' ? data.message : undefined,
        });
      } else if (type === 'chat:done' && cbs.onDone) {
        cbs.onDone({
          msgId,
          stats: data.stats as ChatDonePayload['stats'],
          usage: data.usage as ChatDonePayload['usage'],
        });
      } else if (type === 'chat:error' && cbs.onError) {
        cbs.onError({ msgId, error: String(data.error ?? 'unknown error') });
      }
    } catch { /* don't let one bad listener kill others */ }
  }
}
