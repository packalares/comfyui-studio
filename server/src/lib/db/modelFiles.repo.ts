// Model-files repository. Persists the disk-walk index used by readiness +
// dependency checks so the 535 GiB model tree is walked once at boot (or on
// demand) instead of on every restart. Rows are keyed by `abs_path`; an
// `INSERT ... ON CONFLICT(abs_path) DO UPDATE` upsert lets a rescan refresh
// `scanned_at` cheaply for files that haven't moved.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export type RootKind = 'local' | 'hub';

export interface ModelFileRow {
  abs_path: string;
  filename: string;
  rel_path: string;
  root_kind: RootKind;
  top_dir: string;
  size: number;
  status: string;
  scanned_at: number;
  /** SHA256 hex string (64 chars, lowercase). Null/undefined until Wave 3 hasher runs. */
  sha256?: string | null;
}

function rowFromRecord(row: Record<string, unknown>): ModelFileRow {
  return {
    abs_path: String(row.abs_path),
    filename: String(row.filename),
    rel_path: String(row.rel_path),
    root_kind: row.root_kind === 'hub' ? 'hub' : 'local',
    top_dir: String(row.top_dir),
    size: Number(row.size ?? 0),
    status: String(row.status),
    scanned_at: Number(row.scanned_at ?? 0),
    sha256: row.sha256 != null ? String(row.sha256) : null,
  };
}

export function upsert(
  row: ModelFileRow,
  db: Database.Database = getDb(),
): void {
  db.prepare(`
    INSERT INTO model_files
      (abs_path, filename, rel_path, root_kind, top_dir, size, status, scanned_at)
    VALUES (@abs_path, @filename, @rel_path, @root_kind, @top_dir, @size, @status, @scanned_at)
    ON CONFLICT(abs_path) DO UPDATE SET
      filename   = excluded.filename,
      rel_path   = excluded.rel_path,
      root_kind  = excluded.root_kind,
      top_dir    = excluded.top_dir,
      size       = excluded.size,
      status     = excluded.status,
      scanned_at = excluded.scanned_at
  `).run(row);
}

export function removeByAbsPath(
  absPath: string,
  db: Database.Database = getDb(),
): void {
  db.prepare('DELETE FROM model_files WHERE abs_path = ?').run(absPath);
}

export function has(filename: string, db: Database.Database = getDb()): boolean {
  const row = db.prepare(
    'SELECT 1 AS hit FROM model_files WHERE filename = ? LIMIT 1',
  ).get(filename) as { hit: number } | undefined;
  return !!row;
}

export function hasComplete(
  filename: string,
  db: Database.Database = getDb(),
): boolean {
  const row = db.prepare(
    `SELECT 1 AS hit FROM model_files
     WHERE filename = ? AND status = 'complete' LIMIT 1`,
  ).get(filename) as { hit: number } | undefined;
  return !!row;
}

export function findByDirAndName(
  topDir: string,
  filename: string,
  db: Database.Database = getDb(),
): ModelFileRow | null {
  const row = db.prepare(
    `SELECT * FROM model_files WHERE top_dir = ? AND filename = ? LIMIT 1`,
  ).get(topDir, filename) as Record<string, unknown> | undefined;
  return row ? rowFromRecord(row) : null;
}

/** Look up a row by its on-disk abs_path. abs_path is the table's de-facto
 *  primary key (UPDATEs and DELETEs all use it) so this is the canonical
 *  single-row lookup. */
export function findByAbsPath(
  absPath: string,
  db: Database.Database = getDb(),
): ModelFileRow | null {
  const row = db.prepare(
    'SELECT * FROM model_files WHERE abs_path = ? LIMIT 1',
  ).get(absPath) as Record<string, unknown> | undefined;
  return row ? rowFromRecord(row) : null;
}

export function listByFilename(
  filename: string,
  db: Database.Database = getDb(),
): ModelFileRow[] {
  const rows = db.prepare(
    'SELECT * FROM model_files WHERE filename = ?',
  ).all(filename) as Record<string, unknown>[];
  return rows.map(rowFromRecord);
}

export function listAll(db: Database.Database = getDb()): ModelFileRow[] {
  const rows = db.prepare('SELECT * FROM model_files').all() as Record<string, unknown>[];
  return rows.map(rowFromRecord);
}

export function listKnownTopDirs(db: Database.Database = getDb()): Set<string> {
  const rows = db.prepare(
    'SELECT DISTINCT top_dir FROM model_files',
  ).all() as Array<{ top_dir: string }>;
  return new Set(rows.map((r) => r.top_dir));
}

export function countAll(db: Database.Database = getDb()): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM model_files').get() as { c: number }).c;
}

export function oldestScannedAt(db: Database.Database = getDb()): number | null {
  const row = db.prepare(
    'SELECT MIN(scanned_at) AS m FROM model_files',
  ).get() as { m: number | null } | undefined;
  return row && row.m != null ? Number(row.m) : null;
}

export function deleteScannedBefore(
  cutoff: number,
  db: Database.Database = getDb(),
): number {
  const info = db.prepare(
    'DELETE FROM model_files WHERE scanned_at < ?',
  ).run(cutoff);
  return Number(info.changes);
}

export function deleteAll(db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM model_files').run();
}

/**
 * Store a computed SHA256 for the given absolute path.
 * The value must be a 64-char lowercase hex string.
 * No-op when the row does not exist (stale reference from a deleted file).
 */
export function setSha256(
  absPath: string,
  sha256: string,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    'UPDATE model_files SET sha256 = ? WHERE abs_path = ?',
  ).run(sha256, absPath);
}

export interface MissingSha256Row {
  abs_path: string;
  filename: string;
  size?: number;
}

/**
 * List rows that have no sha256 yet, ordered by ascending size so the
 * background hasher processes small files first. Used by Wave 3's hasher.
 * @param limit - Maximum number of rows to return (default 100).
 */
export function listMissingSha256(
  limit = 100,
  db: Database.Database = getDb(),
): MissingSha256Row[] {
  const rows = db.prepare(
    `SELECT abs_path, filename, size
     FROM model_files
     WHERE sha256 IS NULL
     ORDER BY size ASC
     LIMIT ?`,
  ).all(limit) as Array<{ abs_path: string; filename: string; size: number | null }>;
  return rows.map(r => ({
    abs_path: r.abs_path,
    filename: r.filename,
    size: r.size ?? undefined,
  }));
}

/**
 * Look up model file rows by their SHA256 hash. Used by Wave 8's 5-tier
 * on-disk resolver (Tier 1: hash-first match). The hash is normalised to
 * lowercase before the query so callers need not pre-normalise.
 */
export function listBySha256(
  sha256: string,
  db: Database.Database = getDb(),
): ModelFileRow[] {
  const rows = db.prepare(
    'SELECT * FROM model_files WHERE sha256 = ?',
  ).all(sha256.toLowerCase()) as Record<string, unknown>[];
  return rows.map(rowFromRecord);
}
