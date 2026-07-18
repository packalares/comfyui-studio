// Schema v34 — `packs` table for the capability-pack subsystem.
//
// A "pack" is an optional heavy feature (ACE-Step music, AI-Toolkit training)
// whose pip deps + models install on demand into the persistent volume. This
// table is the durable install-state record consulted at boot / by the UI
// gate; the pack's static metadata (label, deps, model list) lives in the
// in-code registry (`services/packs/registry.ts`), not the DB.
//
// Idempotent: CREATE TABLE IF NOT EXISTS is safe to re-run. No data loss on
// existing DBs. The export follows the pattern of 0002_recipes.ts so
// connection.ts can call it from openAndInit.

import type Database from 'better-sqlite3';

/**
 * Apply the v34 packs migration. Idempotent.
 * Creates the `packs` table if not already present.
 */
export function applyPacksMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS packs (
      id           TEXT PRIMARY KEY,
      installed    INTEGER NOT NULL DEFAULT 0,
      version      TEXT,
      installed_at INTEGER
    );
  `);
}
