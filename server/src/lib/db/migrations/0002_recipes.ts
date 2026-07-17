// Schema v32 — recipes table for saved LoRA combinations.
//
// Idempotent: CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS are safe
// to re-run. No data loss on existing DBs. The export follows the pattern of
// 0001_api_keys.ts so connection.ts can call it from openAndInit.

import type Database from 'better-sqlite3';

/**
 * Apply the v32 recipes migration. Idempotent.
 * Creates the `recipes` table and its title index if not already present.
 */
export function applyRecipesMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      notes       TEXT,
      tags_json   TEXT,
      loras_json  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes(title);
  `);
}
