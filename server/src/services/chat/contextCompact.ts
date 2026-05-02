// Phase F summarization helpers — drives the manual /compact route and the
// automatic 'summarize' strategy. Both share the same one-shot Ollama call:
// stream:false /api/chat asking for a ~200-word recap. The result is then
// persisted (manual path) or returned for inline use (automatic path).
//
// Lives apart from streamChat.ts / contextWindow.ts to keep both under the
// 250-line cap and so the summary pipeline can be unit-tested independently.

import { logger } from '../../lib/logger.js';
import * as repo from '../../lib/db/chat.repo.js';
import {
  deleteAllMessages, lastAssistantMessage,
} from '../../lib/db/chat.context.repo.js';
import * as settings from '../settings.js';
import type { OllamaChatMessage } from './ollamaChat.js';

// Bound the summary call so a stuck Ollama can't leak background fetches.
// Matches the autoTitle.ts timeout (long enough for big models on cold load).
const SUMMARY_TIMEOUT_MS = 60_000;

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

const SUMMARY_PROMPT = 'Summarize the following conversation in approximately 200 words. '
  + 'Preserve the key topics, decisions, and any pending questions. Reply with ONLY '
  + 'the summary, no preamble. The conversation:\n\n';

export async function summarizeText(
  baseUrl: string, model: string, transcript: string,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUMMARY_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: SUMMARY_PROMPT + transcript }],
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

/**
 * Manual /compact: summarizes the entire transcript, deletes all messages,
 * and re-seeds the conversation with a single `system` message containing
 * the summary. Conversation row + telemetry are preserved.
 */
export async function compactConversation(conversationId: string): Promise<CompactResult> {
  const conv = repo.getConversation(conversationId);
  if (!conv) return { ok: false, error: 'conversation not found' };
  const messages = repo.listMessages(conversationId);
  if (messages.length === 0) return { ok: false, error: 'conversation has no messages' };

  const transcript = renderTranscript(messages);
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

  deleteAllMessages(conversationId);
  const now = Date.now();
  repo.appendMessage({
    id: makeId(),
    conversation_id: conversationId,
    role: 'system',
    parts: JSON.stringify([{ type: 'text', text: `Conversation summary so far: ${summary}` }]),
    created_at: now,
  });
  repo.touchConversation(conversationId, now);
  return { ok: true, summary };
}

/**
 * Trim the in-flight `messages` array (Ollama wire shape) so total estimated
 * size stays under `targetPercent` of `budget`. Drops oldest non-system
 * messages first; system prompt is preserved.
 *
 * The returned array references the same string contents — we only filter,
 * never mutate. Used by the 'sliding' strategy.
 */
export function applySlidingWindow(
  messages: OllamaChatMessage[],
  budget: number,
  consumed: number,
  targetPercent: number,
): OllamaChatMessage[] {
  const target = Math.max(0, (targetPercent / 100) * budget);
  if (consumed <= target) return messages;

  // Estimate per-message cost using the same heuristic the meter uses, so the
  // trim threshold is consistent across UI / server.
  const estimated = messages.map(m => ({
    msg: m,
    tokens: Math.ceil((m.content?.length ?? 0) / 4),
  }));
  let total = consumed;
  const keep = new Set<number>();
  // Always keep system messages.
  for (let i = 0; i < estimated.length; i += 1) {
    if (estimated[i].msg.role === 'system') keep.add(i);
  }
  // Walk newest -> oldest, keeping until total drops under target.
  for (let i = estimated.length - 1; i >= 0; i -= 1) {
    if (keep.has(i)) continue;
    keep.add(i);
    if (total <= target) break;
    total -= estimated[i].tokens;
    if (total <= target) break;
  }
  // Drop anything not marked.
  const out: OllamaChatMessage[] = [];
  for (let i = 0; i < estimated.length; i += 1) {
    if (keep.has(i)) out.push(estimated[i].msg);
  }
  return out;
}

/**
 * 'summarize' strategy: replace older messages with a single summary while
 * preserving the latest `keepRecent` user/assistant turns + any system
 * prompt. Mutates the in-flight array, not the persisted DB rows.
 */
export async function applySummarizeStrategy(
  messages: OllamaChatMessage[],
  baseUrl: string, model: string,
  keepRecent = 4,
): Promise<OllamaChatMessage[]> {
  // Anything more than keepRecent non-system messages from the end gets
  // summarized into a single new system message.
  const sysHead = messages.filter(m => m.role === 'system');
  const tail = messages.filter(m => m.role !== 'system');
  if (tail.length <= keepRecent) return messages;
  const olderTail = tail.slice(0, tail.length - keepRecent);
  const recentTail = tail.slice(tail.length - keepRecent);
  const transcript = olderTail
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  let summary = '';
  try {
    summary = await summarizeText(baseUrl, model, transcript);
  } catch (err) {
    logger.warn('summarize-strategy failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return messages; // Best-effort; stream still proceeds with original list.
  }
  if (!summary) return messages;
  const summaryMsg: OllamaChatMessage = {
    role: 'system',
    content: `Conversation summary so far: ${summary}`,
  };
  return [...sysHead, summaryMsg, ...recentTail];
}
