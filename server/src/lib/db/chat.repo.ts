// Chat repository — conversations + messages.
//
// Two tables (`conversations`, `chat_messages`); messages cascade delete
// with their parent conversation. Phase 1: text-only `parts` (JSON
// `UIMessagePart[]` from the AI SDK shape — `[{ type: 'text', text: ... }]`).

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export type ChatRole = 'user' | 'assistant' | 'system';

/** Valid context-window management strategies (Phase F). */
export type ContextStrategy = 'sliding' | 'summarize' | 'manual';
export const CONTEXT_STRATEGIES: readonly ContextStrategy[] = [
  'sliding', 'summarize', 'manual',
] as const;
export function isContextStrategy(v: unknown): v is ContextStrategy {
  return typeof v === 'string'
    && (CONTEXT_STRATEGIES as readonly string[]).includes(v);
}

export interface ConversationRow {
  id: string;
  title: string;
  model: string;
  system_prompt: string | null;
  created_at: number;
  updated_at: number;
  context_strategy: ContextStrategy;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: ChatRole;
  parts: string;
  tokens_in: number | null;
  tokens_out: number | null;
  ms_to_first_token: number | null;
  ms_total: number | null;
  tokens_per_sec: number | null;
  model: string | null;
  created_at: number;
}

export interface ChatTelemetry {
  tokens_in?: number | null;
  tokens_out?: number | null;
  ms_to_first_token?: number | null;
  ms_total?: number | null;
  tokens_per_sec?: number | null;
  model?: string | null;
}

function nullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

function rowToConversation(r: Record<string, unknown>): ConversationRow {
  const rawStrategy = r.context_strategy;
  const strategy: ContextStrategy = isContextStrategy(rawStrategy) ? rawStrategy : 'sliding';
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    model: String(r.model ?? ''),
    system_prompt: nullableString(r.system_prompt),
    created_at: Number(r.created_at ?? 0),
    updated_at: Number(r.updated_at ?? 0),
    context_strategy: strategy,
  };
}

function rowToMessage(r: Record<string, unknown>): ChatMessageRow {
  const role = String(r.role) as ChatRole;
  return {
    id: String(r.id),
    conversation_id: String(r.conversation_id),
    role,
    parts: String(r.parts ?? '[]'),
    tokens_in: nullableNumber(r.tokens_in),
    tokens_out: nullableNumber(r.tokens_out),
    ms_to_first_token: nullableNumber(r.ms_to_first_token),
    ms_total: nullableNumber(r.ms_total),
    tokens_per_sec: nullableNumber(r.tokens_per_sec),
    model: nullableString(r.model),
    created_at: Number(r.created_at ?? 0),
  };
}

export interface CreateConversationInput {
  id: string;
  title: string;
  model: string;
  system_prompt?: string | null;
  created_at: number;
  updated_at: number;
  context_strategy?: ContextStrategy;
}

export function createConversation(
  input: CreateConversationInput,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT INTO conversations
       (id, title, model, system_prompt, created_at, updated_at, context_strategy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id, input.title, input.model,
    input.system_prompt ?? null, input.created_at, input.updated_at,
    input.context_strategy ?? 'sliding',
  );
}

export function listConversations(db: Database.Database = getDb()): ConversationRow[] {
  const rows = db.prepare(
    'SELECT * FROM conversations ORDER BY updated_at DESC',
  ).all() as Record<string, unknown>[];
  return rows.map(rowToConversation);
}

export function getConversation(
  id: string, db: Database.Database = getDb(),
): ConversationRow | null {
  const r = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
    | Record<string, unknown> | undefined;
  return r ? rowToConversation(r) : null;
}

export function deleteConversation(
  id: string, db: Database.Database = getDb(),
): boolean {
  const r = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  return r.changes > 0;
}

export interface UpdateConversationPatch {
  title?: string;
  model?: string;
  system_prompt?: string | null;
}

export function renameConversation(
  id: string,
  patch: UpdateConversationPatch,
  updated_at: number,
  db: Database.Database = getDb(),
): boolean {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
  if (patch.model !== undefined) { sets.push('model = ?'); params.push(patch.model); }
  if (patch.system_prompt !== undefined) {
    sets.push('system_prompt = ?'); params.push(patch.system_prompt);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?'); params.push(updated_at);
  params.push(id);
  const r = db.prepare(
    `UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);
  return r.changes > 0;
}

export function touchConversation(
  id: string, updated_at: number, db: Database.Database = getDb(),
): void {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(updated_at, id);
}

export interface AppendMessageInput {
  id: string;
  conversation_id: string;
  role: ChatRole;
  parts: string;
  created_at: number;
  telemetry?: ChatTelemetry;
}

export function appendMessage(
  input: AppendMessageInput, db: Database.Database = getDb(),
): void {
  const t = input.telemetry ?? {};
  db.prepare(
    `INSERT INTO chat_messages
       (id, conversation_id, role, parts, tokens_in, tokens_out,
        ms_to_first_token, ms_total, tokens_per_sec, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id, input.conversation_id, input.role, input.parts,
    t.tokens_in ?? null, t.tokens_out ?? null,
    t.ms_to_first_token ?? null, t.ms_total ?? null,
    t.tokens_per_sec ?? null, t.model ?? null,
    input.created_at,
  );
}

export function listMessages(
  conversationId: string, db: Database.Database = getDb(),
): ChatMessageRow[] {
  const rows = db.prepare(
    `SELECT * FROM chat_messages WHERE conversation_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).all(conversationId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function updateMessageTelemetry(
  id: string, telemetry: ChatTelemetry, db: Database.Database = getDb(),
): boolean {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(telemetry)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (sets.length === 0) return false;
  params.push(id);
  const r = db.prepare(
    `UPDATE chat_messages SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);
  return r.changes > 0;
}

export function updateMessageParts(
  id: string, parts: string, db: Database.Database = getDb(),
): boolean {
  const r = db.prepare('UPDATE chat_messages SET parts = ? WHERE id = ?').run(parts, id);
  return r.changes > 0;
}

/** Internal — exposed so the sibling `chat.context.repo.ts` can rebuild rows. */
export function _rowToMessage(r: Record<string, unknown>): ChatMessageRow {
  return rowToMessage(r);
}
