// Schema v29 — api_keys table for the API-key auth layer.
//
// Idempotent: re-running this on any DB state (fresh / already-migrated /
// contaminated by a prior incompatible api_keys shape) converges to the v29
// canonical shape. The matching DDL is duplicated in `schema.ts`'s SCHEMA_SQL
// so `db.exec(SCHEMA_SQL)` in `connection.ts#openAndInit` handles fresh DBs
// in the same single pass as every other table. This module exports
// `applyApiKeysMigration` so connection.ts (or tests) can invoke just this
// migration in isolation — required to clear contaminated shapes that
// CREATE TABLE IF NOT EXISTS won't touch.

import type Database from 'better-sqlite3';

export const API_KEYS_MIGRATION_VERSION = 29;

const CANONICAL_COLS = [
  'id', 'prefix', 'hash', 'name', 'scopes',
  'created_at', 'last_used_at', 'expires_at', 'revoked_at',
] as const;

export const API_KEYS_DDL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL UNIQUE,
  hash         TEXT NOT NULL,
  name         TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix     ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_created_at ON api_keys(created_at DESC);
`;

/**
 * Apply the v29 api_keys migration. Idempotent. Detects and replaces any
 * pre-existing incompatible api_keys shape (e.g. a stale `user_id` / `key_hash`
 * variant from earlier scaffolding) by dropping the table first — there is no
 * production data to preserve, and a shape mismatch would silently break every
 * read path because CREATE TABLE IF NOT EXISTS is a no-op on the wrong shape.
 */
export function applyApiKeysMigration(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const present = new Set(cols.map(c => c.name));
    const matches = CANONICAL_COLS.every(c => present.has(c)) && cols.length === CANONICAL_COLS.length;
    if (!matches) {
      // Drop indexes first so they don't survive the table swap with stale defs.
      db.exec('DROP INDEX IF EXISTS idx_api_keys_prefix');
      db.exec('DROP INDEX IF EXISTS idx_api_keys_created_at');
      db.exec('DROP TABLE api_keys');
    }
  }
  db.exec(API_KEYS_DDL);
}
