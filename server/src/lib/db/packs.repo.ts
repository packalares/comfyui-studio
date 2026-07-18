// Repository for the `packs` table — durable install-state for the
// capability-pack subsystem (see `services/packs/registry.ts` for the static
// metadata each row's `id` corresponds to).
//
// Rows are upserted lazily: a pack that has never been installed simply has
// no row, and `getPack` returns `null` for it. `listPacks` is used by the
// registry-merge in the route layer to report installed state alongside the
// static registry entries.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export interface PackRow {
  id: string;
  installed: boolean;
  version: string | null;
  installedAt: number | null;
}

function rowToEntry(r: Record<string, unknown>): PackRow {
  return {
    id: String(r.id),
    installed: Number(r.installed) === 1,
    version: r.version == null ? null : String(r.version),
    installedAt: r.installed_at == null ? null : Number(r.installed_at),
  };
}

export function listPacks(db: Database.Database = getDb()): PackRow[] {
  const rows = db.prepare('SELECT * FROM packs ORDER BY id ASC').all() as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function getPack(id: string, db: Database.Database = getDb()): PackRow | null {
  const r = db.prepare('SELECT * FROM packs WHERE id = ?').get(id) as
    | Record<string, unknown> | undefined;
  return r ? rowToEntry(r) : null;
}

/**
 * Upsert the install state for `id`. `version` is only meaningful when
 * `installed` is true; pass `undefined` to leave it untouched (e.g. an
 * uninstall clearing the flag but keeping the last-known version around for
 * display) or `null` to clear it explicitly.
 */
export function setInstalled(
  id: string,
  installed: boolean,
  version?: string | null,
  db: Database.Database = getDb(),
): void {
  const existing = getPack(id, db);
  const nextVersion = version === undefined ? (existing?.version ?? null) : version;
  const installedAt = installed ? Date.now() : (existing?.installedAt ?? null);
  db.prepare(`
    INSERT INTO packs (id, installed, version, installed_at)
    VALUES (@id, @installed, @version, @installed_at)
    ON CONFLICT(id) DO UPDATE SET
      installed    = excluded.installed,
      version      = excluded.version,
      installed_at = excluded.installed_at
  `).run({
    id,
    installed: installed ? 1 : 0,
    version: nextVersion,
    installed_at: installedAt,
  });
}
