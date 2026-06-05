// Chat event broadcast hub.
//
// Two output paths share the same emitChatEvent() entrypoint:
//   1. WS global bus — all events forwarded to every connected WS client.
//   2. Per-conversation SSE streams — events routed to subscribers registered
//      via convSubscriber.subscribeToConvStream().
//
// The SSE path requires a `conversationId` on the envelope. `chat:start`
// carries it explicitly; for subsequent events (chunk/reasoning/tool/done/
// error) we maintain a msgId→conversationId registry that streamChat
// populates via registerInFlight / unregisterInFlight.

import { dispatchToConvSubscribers } from './convSubscriber.js';

let broadcaster: ((message: object) => void) | null = null;

export function setChatBroadcaster(fn: ((message: object) => void) | null): void {
  broadcaster = fn;
}

// msgId → conversationId. Set when streamChat registers an in-flight stream;
// cleared on done/error/abort so we don't leak entries indefinitely.
const msgToConv = new Map<string, string>();

export function registerInFlight(msgId: string, conversationId: string): void {
  msgToConv.set(msgId, conversationId);
}

export function unregisterInFlight(msgId: string): void {
  msgToConv.delete(msgId);
}

export function emitChatEvent(message: object): void {
  // WS path — unchanged.
  if (broadcaster) broadcaster(message);

  // SSE path — resolve conversationId for per-conv routing.
  const env = message as { type?: string; data?: Record<string, unknown> };
  if (!env.type || !env.data) return;

  const data = env.data;
  // chat:start is the only event that carries conversationId directly.
  // Register it so subsequent msgId-only events can be routed.
  if (env.type === 'chat:start') {
    const convId = typeof data.conversationId === 'string' ? data.conversationId : null;
    const msgId = typeof data.msgId === 'string' ? data.msgId : null;
    if (convId && msgId) registerInFlight(msgId, convId);
  }

  // Resolve conversationId: prefer envelope field, fall back to registry.
  let conversationId = typeof data.conversationId === 'string' ? data.conversationId : null;
  if (!conversationId && typeof data.msgId === 'string') {
    conversationId = msgToConv.get(data.msgId) ?? null;
  }
  if (!conversationId) return;

  dispatchToConvSubscribers(env.type, { ...data, conversationId });

  // Clean up registry on terminal events.
  if (
    (env.type === 'chat:done' || env.type === 'chat:error') &&
    typeof data.msgId === 'string'
  ) {
    unregisterInFlight(data.msgId);
  }
}
