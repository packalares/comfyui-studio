// Repository for `pack_models` + `pack_settings` (migration 0008) — per-pack
// install DEVIATIONS from the static catalog in `services/packs/registry.ts`.
// A model/pack with no row here simply falls back to the registry's declared
// default; see that migration's header comment for the full rationale.
//
// Single-user: no `user_id` column, matching every other repo in this schema.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export type PackModelState = 'absent' | 'downloading' | 'downloaded' | 'failed';

export interface PackModelRow {
  packId: string;
  modelId: string;
  /** `null` = follow the registry's `default`; `true`/`false` = explicit
   *  user override recorded via `PATCH /packs/:id/settings`. */
  selected: boolean | null;
  state: PackModelState;
  repoOverride: string | null;
  dest: string | null;
  sizeBytes: number | null;
  downloadedAt: number | null;
}

interface PackModelDbRow {
  pack_id: string;
  model_id: string;
  selected: number | null;
  state: PackModelState;
  repo_override: string | null;
  dest: string | null;
  size_bytes: number | null;
  downloaded_at: number | null;
}

function rowToModel(r: PackModelDbRow): PackModelRow {
  return {
    packId: r.pack_id,
    modelId: r.model_id,
    selected: r.selected == null ? null : r.selected === 1,
    state: r.state,
    repoOverride: r.repo_override,
    dest: r.dest,
    sizeBytes: r.size_bytes,
    downloadedAt: r.downloaded_at,
  };
}

/** Ensure a row exists for (packId, modelId), returning it. Every mutator
 *  below goes through this so a partial update never has to special-case
 *  "no row yet" separately from "row exists". */
function ensureRow(packId: string, modelId: string, db: Database.Database): PackModelDbRow {
  const existing = db.prepare(
    'SELECT * FROM pack_models WHERE pack_id = ? AND model_id = ?',
  ).get(packId, modelId) as PackModelDbRow | undefined;
  if (existing) return existing;
  db.prepare(`
    INSERT INTO pack_models (pack_id, model_id, state)
    VALUES (@pack_id, @model_id, 'absent')
  `).run({ pack_id: packId, model_id: modelId });
  return db.prepare(
    'SELECT * FROM pack_models WHERE pack_id = ? AND model_id = ?',
  ).get(packId, modelId) as PackModelDbRow;
}

export function getModelRow(
  packId: string,
  modelId: string,
  db: Database.Database = getDb(),
): PackModelRow | null {
  const r = db.prepare(
    'SELECT * FROM pack_models WHERE pack_id = ? AND model_id = ?',
  ).get(packId, modelId) as PackModelDbRow | undefined;
  return r ? rowToModel(r) : null;
}

export function listModelRows(packId: string, db: Database.Database = getDb()): PackModelRow[] {
  const rows = db.prepare(
    'SELECT * FROM pack_models WHERE pack_id = ? ORDER BY model_id ASC',
  ).all(packId) as PackModelDbRow[];
  return rows.map(rowToModel);
}

/** Explicit select/deselect override. `null` resets to "follow the registry
 *  default" (clears the deviation rather than merely setting it false). */
export function setSelected(
  packId: string,
  modelId: string,
  selected: boolean | null,
  db: Database.Database = getDb(),
): void {
  ensureRow(packId, modelId, db);
  db.prepare(
    'UPDATE pack_models SET selected = ? WHERE pack_id = ? AND model_id = ?',
  ).run(selected == null ? null : (selected ? 1 : 0), packId, modelId);
}

/** Repo override. `null`/empty resets to the registry's default repo. */
export function setRepoOverride(
  packId: string,
  modelId: string,
  repoOverride: string | null,
  db: Database.Database = getDb(),
): void {
  ensureRow(packId, modelId, db);
  db.prepare(
    'UPDATE pack_models SET repo_override = ? WHERE pack_id = ? AND model_id = ?',
  ).run(repoOverride && repoOverride.length > 0 ? repoOverride : null, packId, modelId);
}

export interface SetStateExtra {
  dest?: string | null;
  sizeBytes?: number | null;
  downloadedAt?: number | null;
}

/** Record a download lifecycle transition (absent -> downloading ->
 *  downloaded|failed). Written by `services/packs/install.ts` only — never
 *  by the settings PATCH route. */
export function setState(
  packId: string,
  modelId: string,
  state: PackModelState,
  extra: SetStateExtra = {},
  db: Database.Database = getDb(),
): void {
  ensureRow(packId, modelId, db);
  const sets: string[] = ['state = @state'];
  const params: Record<string, unknown> = { pack_id: packId, model_id: modelId, state };
  if ('dest' in extra) { sets.push('dest = @dest'); params.dest = extra.dest ?? null; }
  if ('sizeBytes' in extra) { sets.push('size_bytes = @size_bytes'); params.size_bytes = extra.sizeBytes ?? null; }
  if ('downloadedAt' in extra) { sets.push('downloaded_at = @downloaded_at'); params.downloaded_at = extra.downloadedAt ?? null; }
  db.prepare(
    `UPDATE pack_models SET ${sets.join(', ')} WHERE pack_id = @pack_id AND model_id = @model_id`,
  ).run(params);
}

// ---- pack_settings (generic per-pack k/v overrides) ----

export function getSetting(packId: string, key: string, db: Database.Database = getDb()): string | null {
  const r = db.prepare(
    'SELECT value FROM pack_settings WHERE pack_id = ? AND key = ?',
  ).get(packId, key) as { value: string | null } | undefined;
  return r ? r.value : null;
}

export function listSettings(packId: string, db: Database.Database = getDb()): Record<string, string> {
  const rows = db.prepare(
    'SELECT key, value FROM pack_settings WHERE pack_id = ?',
  ).all(packId) as Array<{ key: string; value: string | null }>;
  const out: Record<string, string> = {};
  for (const r of rows) if (r.value != null) out[r.key] = r.value;
  return out;
}

export function setSetting(packId: string, key: string, value: string, db: Database.Database = getDb()): void {
  db.prepare(`
    INSERT INTO pack_settings (pack_id, key, value)
    VALUES (@pack_id, @key, @value)
    ON CONFLICT(pack_id, key) DO UPDATE SET value = excluded.value
  `).run({ pack_id: packId, key, value });
}

export function deleteSetting(packId: string, key: string, db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM pack_settings WHERE pack_id = ? AND key = ?').run(packId, key);
}
