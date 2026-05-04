// Strategy enforcement bridge — invoked by streamChat.ts before firing the
// request so context-window management runs uniformly across streaming +
// tool-dispatch paths. Lives apart from streamChat.ts to keep that file
// under the 250-line cap.
//
// Two strategies (since v13):
//   - 'sliding' — non-destructive trim of the OUTGOING message list; keep
//     the latest N non-system turns plus all system messages. DB
//     untouched.
//   - 'auto'    — destructive Compact: summarize the conversation,
//     delete the persisted history (except the just-appended user
//     message + assistant placeholder), insert one synthetic system row
//     containing the summary. UI re-hydrates via `chat:compacted`.
//
// Both fire only when `usage.percent >= chatHighWaterPercent` (default 80).
// Below that the message list is passed through untouched.

import { logger } from '../../lib/logger.js';
import { computeUsage } from './contextWindow.js';
import {
  applySlidingWindow, compactConversation,
} from './contextCompact.js';
import { emitChatEvent } from './broadcaster.js';
import type { OllamaChatMessage } from './ollamaChat.js';
import * as repo from '../../lib/db/chat.repo.js';
import * as settings from '../settings.js';

export interface EnforceContextArgs {
  conversationId: string;
  model: string;
  baseUrl: string;
  pendingUserText: string;
  messages: OllamaChatMessage[];
  msgId: string;
  /** Ids of the just-appended user message + assistant placeholder. The
   *  'auto' strategy preserves these on the DB destructive write so the
   *  in-flight turn keeps working. `null` when no user message exists
   *  yet (regenerate path). */
  preserveIds: ReadonlySet<string>;
}

export async function enforceContextStrategy(
  args: EnforceContextArgs,
): Promise<OllamaChatMessage[]> {
  let usage;
  try {
    usage = await computeUsage({
      conversationId: args.conversationId,
      model: args.model,
      pendingUserText: args.pendingUserText,
    });
  } catch (err) {
    logger.warn('context-usage probe failed', {
      conversationId: args.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return args.messages;
  }
  if (usage.percent < settings.getChatHighWaterPercent()) return args.messages;

  if (usage.strategy === 'sliding') {
    return applySlidingWindow(args.messages);
  }

  // 'auto' — destructive Compact. Surface a status banner so the UI can
  // explain the pause; the summarizer call typically takes 2–6s.
  emitChatEvent({
    type: 'chat:status',
    data: { msgId: args.msgId, code: 'compacting' },
  });

  const result = await compactConversation(args.conversationId, {
    preserveIds: args.preserveIds,
  });
  if (!result.ok) {
    logger.warn('auto-compact failed; sending original messages', {
      conversationId: args.conversationId,
      error: result.error,
    });
    return args.messages;
  }

  // Re-hydrate the wire-shape list from the freshly rewritten DB so the
  // request body reflects the new (summary + preserved tail) state.
  // Convert the persisted ChatMessageRow shape into OllamaChatMessage by
  // way of the same helper streamChat uses for the initial hydrate.
  const refreshed = repo.listMessages(args.conversationId);
  const wired = persistedMessagesToWire(refreshed);

  // Tell the UI to re-hydrate scrollback — the destructive write deleted
  // every message that wasn't preserved.
  emitChatEvent({
    type: 'chat:compacted',
    data: { conversationId: args.conversationId },
  });

  return wired;
}

/**
 * ChatMessageRow → OllamaChatMessage. Concatenates every text/reasoning
 * part on each row into a single content string (Ollama wire shape
 * doesn't carry structured parts). Skips rows whose role isn't
 * user/assistant/system, and rows that end up with empty content.
 */
function persistedMessagesToWire(rows: repo.ChatMessageRow[]): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant' && r.role !== 'system') continue;
    let parts: unknown = [];
    try { parts = JSON.parse(r.parts); } catch { /* keep parts = [] */ }
    if (!Array.isArray(parts)) continue;
    const textChunks: string[] = [];
    for (const part of parts) {
      const p = part as { type?: string; text?: string };
      if ((p.type === 'text' || p.type === 'reasoning') && typeof p.text === 'string') {
        textChunks.push(p.text);
      }
    }
    const content = textChunks.join('\n').trim();
    if (content.length === 0) continue;
    out.push({ role: r.role, content });
  }
  return out;
}
