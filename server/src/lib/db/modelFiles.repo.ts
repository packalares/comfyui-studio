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
