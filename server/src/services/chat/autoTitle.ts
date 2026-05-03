// Best-effort conversation auto-title. Runs after the first assistant turn
// completes so it never blocks streaming. Lives apart from streamChat.ts to
// keep that file under the 250-line cap. The single export is used by
// streamChat.ts via `void maybeAutoTitle(...)` — no caller awaits it.

import type { UIMessage } from 'ai';
import { logger } from '../../lib/logger.js';
import * as repo from '../../lib/db/chat.repo.js';
import * as settings from '../settings.js';
import { emitChatEvent } from './broadcaster.js';
import { TITLE_PROMPT } from './prompts.js';

export interface AutoTitleArgs {
  conversationId: string;
  model: string;
  baseUrl: string;
  userText: string;
  assistantText: string;
}

// Bound moved to settings (`chatTitleTimeoutMs`). Resolved at the call
// site so a settings change picks up without restart.

export async function maybeAutoTitle(args: AutoTitleArgs): Promise<void> {
  try {
    const conv = repo.getConversation(args.conversationId);
    if (!conv) return;
    // Only auto-title rows still on the seeded title — anything else was
    // either picked by the user (PATCH) or already auto-titled on a prior run.
    const seeded = conv.title;
    const looksDefault = !seeded
      || seeded === 'New chat'
      || (args.userText.length > 0 && seeded.startsWith(args.userText.slice(0, 40)));
    if (!looksDefault) return;

    const prompt = TITLE_PROMPT(args.userText, args.assistantText);
    const text = await callOllamaOneShot(args.baseUrl, args.model, prompt);
    const title = sanitizeTitle(text);
    if (!title) return;
    repo.renameConversation(args.conversationId, { title }, Date.now());
    emitChatEvent({
      type: 'chat:title',
      data: { conversationId: args.conversationId, title },
    });
  } catch (err) {
    logger.warn('auto-title failed', {
      conversationId: args.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Tiny non-streaming /api/chat call. Skips the streamChat helpers because
// this path doesn't need partial deltas, telemetry, or images — just the
// final string. Mirrors the same auth/url conventions as streamChat.ts.
async function callOllamaOneShot(baseUrl: string, model: string, prompt: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), settings.getChatTitleTimeoutMs());
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`upstream ${res.status} ${res.statusText}`);
    const body = await res.json() as { message?: { content?: unknown } };
    const content = body?.message?.content;
    return typeof content === 'string' ? content : '';
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeTitle(raw: string): string {
  // Models routinely wrap titles in quotes or trail punctuation despite the
  // explicit instruction; strip both before persisting.
  let t = (raw ?? '').trim().replace(/^["'`]+|["'`.!?]+$/g, '').trim();
  if (t.length > 80) t = t.slice(0, 77) + '...';
  return t;
}

export function lastUserText(messages: UIMessage[]): string {
  const u = [...messages].reverse().find(m => m.role === 'user');
  if (!u) return '';
  return (u.parts ?? [])
    .filter(p => (p as { type?: string }).type === 'text')
    .map(p => String((p as { text?: string }).text ?? ''))
    .join(' ')
    .trim();
}
