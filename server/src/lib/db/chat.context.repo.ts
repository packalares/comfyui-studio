// Phase F context-window management helpers — kept apart from `chat.repo.ts`
// so the parent file stays under the 250-line structure cap. Strategy
// accessors operate on the additive `context_strategy` column added in
// schema v7; compaction helpers (last assistant message + bulk delete)
// support the manual /compact route + automatic summarize strategy.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';
import {
  isContextStrategy,
  type ChatMessageRow,
  type ContextStrategy,
  _rowToMessage,
} from './chat.repo.js';

export function getStrategy(
  conversationId: string, db: Database.Database = getDb(),
): ContextStrategy {
  const r = db.prepare(
    'SELECT context_strategy FROM conversations WHERE id = ?',
  ).get(conversationId) as { context_strategy?: unknown } | undefined;
  if (!r) return 'sliding';
  return isContextStrategy(r.context_strategy) ? r.context_strategy : 'sliding';
}

export function setStrategy(
  conversationId: string, strategy: ContextStrategy,
  db: Database.Database = getDb(),
): boolean {
  const r = db.prepare(
    'UPDATE conversations SET context_strategy = ? WHERE id = ?',
  ).run(strategy, conversationId);
  return r.changes > 0;
}

/**
 * Last assistant message in the conversation. computeUsage reads its
 * `tokens_in` (Ollama's `prompt_eval_count`) — that's the cumulative prompt
 * size at the most recent turn, the closest the server has to a "context
 * size on disk" estimate.
 */
export function lastAssistantMessage(
  conversationId: string, db: Database.Database = getDb(),
): ChatMessageRow | null {
  const r = db.prepare(
    `SELECT * FROM chat_messages
     WHERE conversation_id = ? AND role = 'assistant'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(conversationId) as Record<string, unknown> | undefined;
  return r ? _rowToMessage(r) : null;
}

/** Drop every message in the conversation. Used by /compact before re-seeding. */
export function deleteAllMessages(
  conversationId: string, db: Database.Database = getDb(),
): number {
  const r = db.prepare(
    'DELETE FROM chat_messages WHERE conversation_id = ?',
  ).run(conversationId);
  return r.changes;
}
