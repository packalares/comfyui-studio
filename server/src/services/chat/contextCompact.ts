// Compaction + sliding-window helpers shared by the manual /compact route
// and the automatic 'auto' strategy.
//
// `compactConversation` is destructive: it summarizes the transcript via a
// stream:false /api/chat call, deletes the persisted message rows, and
// re-seeds with one synthetic system message containing the summary. The
// auto path passes `preserveIds` so the just-appended user message + the
// in-flight assistant placeholder survive the destructive write — without
// that, the user's typed turn would vanish before the model ever saw it.
//
// `applySlidingWindow` is non-destructive and runs entirely on the
// outgoing in-flight message list. Keeps the latest N user/assistant
// turns (`chatKeepRecent`) plus any system messages; everything older is
// dropped from THIS request only. DB rows are untouched.

import * as repo from '../../lib/db/chat.repo.js';
import {
  deleteAllMessages, deleteMessagesNotIn,
} from '../../lib/db/chat.context.repo.js';
import * as settings from '../settings.js';
import type { OllamaChatMessage } from './ollamaChat.js';
import { COMPACT_SUMMARY_PROMPT_PREFIX, COMPACT_SUMMARY_WRAP } from './prompts.js';

/** Render every chat message as a flat transcript for the summarizer prompt. */
function renderTranscript(rows: repo.ChatMessageRow[]): string {
  const out: string[] = [];
  for (const r of rows) {
    let parts: unknown = [];
    try { parts = JSON.parse(r.parts); } catch { /* keep parts = [] */ }
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter(p => p && typeof p === 'object' && (p as { type?: string }).type === 'text')
      .map(p => String((p as { text?: string }).text ?? ''))
      .join(' ')
      .trim();
    if (!text) continue;
    const speaker = r.role === 'user' ? 'User' : r.role === 'assistant' ? 'Assistant' : 'System';
    out.push(`${speaker}: ${text}`);
  }
  return out.join('\n');
}

export async function summarizeText(
  baseUrl: string, model: string, transcript: string,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), settings.getChatSummaryTimeoutMs());
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: COMPACT_SUMMARY_PROMPT_PREFIX + transcript }],
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
    const body = await res.json() as { message?: { content?: unknown } };
    const content = body?.message?.content;
    return typeof content === 'string' ? content.trim() : '';
  } finally {
    clearTimeout(timer);
  }
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export interface CompactResult {
  ok: boolean;
  summary?: string;
  error?: string;
}

export interface CompactOptions {
  /** Message ids that survive the destructive write. Excluded from the
   *  summarized transcript AND retained on disk. The summary system row
   *  is inserted with a `created_at` earlier than every preserved row so
   *  it sorts to the top of the rebuilt thread. */
  preserveIds?: ReadonlySet<string>;
}

/**
 * Summarizes the conversation, deletes all messages (except `preserveIds`),
 * and re-seeds with a single `system` row containing the summary. Used by:
 *   - the manual `/compact` route (no preserveIds — full wipe)
 *   - the 'auto' strategy in `enforceContextStrategy` (preserves the
 *     just-appended user msg + assistant placeholder so the in-flight
 *     turn keeps working)
 */
export async function compactConversation(
  conversationId: string,
  opts: CompactOptions = {},
): Promise<CompactResult> {
  const conv = repo.getConversation(conversationId);
  if (!conv) return { ok: false, error: 'conversation not found' };
  const preserve = opts.preserveIds ?? new Set<string>();
  const allMessages = repo.listMessages(conversationId);
  if (allMessages.length === 0) return { ok: false, error: 'conversation has no messages' };

  // Summarize only the messages that won't be preserved. If `preserveIds`
  // covers everything (edge case — short conversation triggered the
  // strategy), there's nothing to summarize and we leave the DB alone.
  const toSummarize = allMessages.filter(m => !preserve.has(m.id));
  if (toSummarize.length === 0) return { ok: false, error: 'no messages to summarize' };

  const transcript = renderTranscript(toSummarize);
  if (!transcript) return { ok: false, error: 'no text content to summarize' };

  const baseUrl = settings.getOllamaUrl();
  let summary = '';
  try {
    summary = await summarizeText(baseUrl, conv.model, transcript);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!summary) return { ok: false, error: 'empty summary from upstream' };

  // Delete everything that wasn't preserved. Using a single SQL pass
  // avoids inconsistent intermediate states under concurrent reads.
  if (preserve.size === 0) {
    deleteAllMessages(conversationId);
  } else {
    deleteMessagesNotIn(conversationId, preserve);
  }

  // Insert the summary BEFORE every preserved row so the rebuilt thread
  // reads as: [system summary, preserved user msg, preserved assistant
  // placeholder, ...]. We pick `created_at` 1 ms before the earliest
  // preserved row's `created_at`; if nothing is preserved we use Date.now.
  const earliestPreserved = allMessages
    .filter(m => preserve.has(m.id))
    .reduce<number | null>((acc, m) => acc === null || m.created_at < acc ? m.created_at : acc, null);
  const summaryCreatedAt = earliestPreserved !== null
    ? Math.max(0, earliestPreserved - 1)
    : Date.now();

  repo.appendMessage({
    id: makeId(),
    conversation_id: conversationId,
    role: 'system',
    parts: JSON.stringify([{ type: 'text', text: COMPACT_SUMMARY_WRAP(summary) }]),
    created_at: summaryCreatedAt,
  });
  repo.touchConversation(conversationId, Date.now());
  return { ok: true, summary };
}

/**
 * Sliding strategy: filter the in-flight `messages` (Ollama wire shape) so
 * the model sees only the last `keepRecent` non-system turns plus every
 * system message. DB is never touched — recovery is just "switch
 * strategy" or wait for context to drop below the threshold.
 *
 * `keepRecent` defaults to `settings.getChatKeepRecent()` so a global
 * setting tweak is picked up on the next call.
 */
export function applySlidingWindow(
  messages: OllamaChatMessage[],
  keepRecent = settings.getChatKeepRecent(),
): OllamaChatMessage[] {
  const sysHead = messages.filter(m => m.role === 'system');
  const tail = messages.filter(m => m.role !== 'system');
  if (tail.length <= keepRecent) return messages;
  return [...sysHead, ...tail.slice(tail.length - keepRecent)];
}
