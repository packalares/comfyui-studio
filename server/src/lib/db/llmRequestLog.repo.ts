// Per-API-key request log: the last N (prompt, response) pairs for keys used on
// the public LLM API. Pruned to N-per-key on insert, and deleted alongside the
// key (see apiKeys.repo delete paths) so no rows are orphaned.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

/** How many requests we keep per key. */
export const LLM_LOG_KEEP_PER_KEY = 10;

export interface LlmRequestLogRow {
  id: number;
  keyId: string;
  ts: number;
  endpoint: string;
  model: string | null;
  prompt: string;
  response: string;
  status: number | null;
}

interface RawRow {
  id: number; key_id: string; ts: number; endpoint: string;
  model: string | null; prompt: string; response: string; status: number | null;
}

/** Insert one log row, then prune this key back to the last N. */
export function insertLlmRequestLog(
  rec: { keyId: string; endpoint: string; model: string | null; prompt: string; response: string; status: number | null },
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT INTO llm_request_log (key_id, ts, endpoint, model, prompt, response, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(rec.keyId, Date.now(), rec.endpoint, rec.model, rec.prompt, rec.response, rec.status);
  db.prepare(
    `DELETE FROM llm_request_log
      WHERE key_id = ?
        AND id NOT IN (
          SELECT id FROM llm_request_log WHERE key_id = ? ORDER BY ts DESC, id DESC LIMIT ?
        )`,
  ).run(rec.keyId, rec.keyId, LLM_LOG_KEEP_PER_KEY);
}

/** Last N log rows for a key, newest first. */
export function listLlmRequestLog(
  keyId: string,
  db: Database.Database = getDb(),
): LlmRequestLogRow[] {
  const rows = db.prepare(
    `SELECT id, key_id, ts, endpoint, model, prompt, response, status
       FROM llm_request_log WHERE key_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
  ).all(keyId, LLM_LOG_KEEP_PER_KEY) as RawRow[];
  return rows.map((r) => ({
    id: r.id, keyId: r.key_id, ts: r.ts, endpoint: r.endpoint,
    model: r.model, prompt: r.prompt, response: r.response, status: r.status,
  }));
}

/** Delete all log rows for a key (called when the key is hard-deleted). */
export function deleteLlmRequestLogForKey(keyId: string, db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM llm_request_log WHERE key_id = ?').run(keyId);
}

/** Sweep any log rows whose key no longer exists (used after bulk key deletes). */
export function deleteOrphanedLlmRequestLog(db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM llm_request_log WHERE key_id NOT IN (SELECT id FROM api_keys)').run();
}
