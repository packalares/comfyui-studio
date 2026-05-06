// Prompt snapshot repo — stores the apiPromptJson submitted to ComfyUI
// alongside its promptId so gallery hydration can fall back to the snapshot
// when ComfyUI's /api/history returns null (the 500ms-retry race).
//
// Rows are keyed on promptId (PRIMARY KEY). The table is intentionally
// short-lived: rows are deleted after a successful gallery row creation, and
// a TTL sweep (registered in index.ts) purges orphans older than 1 hour.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export interface PromptSnapshot {
  promptId: string;
  apiPromptJson: string;
  templateName?: string | null;
  createdAt: number;
}

export interface InsertSnapshotInput {
  promptId: string;
  apiPromptJson: string;
  templateName?: string | null;
}

export function insertSnapshot(
  input: InsertSnapshotInput,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT OR REPLACE INTO prompt_snapshots (promptId, apiPromptJson, templateName, createdAt)
     VALUES (?, ?, ?, ?)`,
  ).run(input.promptId, input.apiPromptJson, input.templateName ?? null, Date.now());
}

export function getSnapshot(
  promptId: string,
  db: Database.Database = getDb(),
): Omit<PromptSnapshot, 'promptId'> | null {
  const row = db.prepare(
    'SELECT apiPromptJson, templateName, createdAt FROM prompt_snapshots WHERE promptId = ?',
  ).get(promptId) as { apiPromptJson: string; templateName: string | null; createdAt: number } | undefined;
  if (!row) return null;
  return { apiPromptJson: row.apiPromptJson, templateName: row.templateName, createdAt: row.createdAt };
}

export function deleteSnapshot(
  promptId: string,
  db: Database.Database = getDb(),
): boolean {
  const r = db.prepare('DELETE FROM prompt_snapshots WHERE promptId = ?').run(promptId);
  return r.changes > 0;
}

/** Delete rows older than `maxAgeMs` milliseconds. Returns number deleted. */
export function sweepOldSnapshots(
  maxAgeMs: number,
  db: Database.Database = getDb(),
): number {
  const cutoff = Date.now() - maxAgeMs;
  const r = db.prepare('DELETE FROM prompt_snapshots WHERE createdAt < ?').run(cutoff);
  return r.changes;
}
