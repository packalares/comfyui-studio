// Schema migration test. Builds a pre-Wave-F gallery database by hand
// (no Wave F columns, with some existing rows), then re-opens the file
// through the normal `getDb()` path and verifies:
//  - the new columns are present (ALTER TABLE ADD COLUMN ran)
//  - the one-shot wipe cleared the legacy rows
//  - a second open does NOT re-wipe (idempotent guard in _meta)

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getDb, resetForTests } from '../../../src/lib/db/connection.js';

function pragmaCols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(c => c.name);
}

describe('gallery schema migration', () => {
  it('adds missing columns + one-shot wipes legacy rows, idempotent on 2nd boot', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studio-migration-'));
    const dbPath = path.join(dir, 'studio.db');

    // ---- Pre-seed: create a DB with the OLD schema (no Wave F cols) ----
    const pre = new Database(dbPath);
    pre.exec(`
      CREATE TABLE gallery (
        id          TEXT PRIMARY KEY,
        filename    TEXT NOT NULL,
        subfolder   TEXT NOT NULL DEFAULT '',
        mediaType   TEXT NOT NULL,
        createdAt   INTEGER NOT NULL,
        templateName TEXT,
        promptId    TEXT,
        sizeBytes   INTEGER,
        url         TEXT,
        type        TEXT NOT NULL DEFAULT 'output'
      );
    `);
    for (let i = 0; i < 3; i++) {
      pre.prepare(
        `INSERT INTO gallery (id, filename, mediaType, createdAt, url) VALUES (?, ?, ?, ?, ?)`,
      ).run(`legacy-${i}`, `f${i}.png`, 'image', 1000 + i, `/api/view?filename=f${i}.png`);
    }
    expect(pragmaCols(pre, 'gallery')).not.toContain('workflowJson');
    pre.close();

    // ---- First open: migration should run + wipe ----
    process.env.STUDIO_SQLITE_PATH = dbPath;
    resetForTests();
    const db = getDb();
    const cols = pragmaCols(db, 'gallery');
    // v21: workflowJson is kept; extracted columns are dropped.
    expect(cols).toContain('workflowJson');
    expect(cols).toContain('jobDurationMs');
    expect(cols).toContain('mediaDurationMs');
    expect(cols).toContain('mediaInfoJson');
    // Extracted columns must be absent after v21 migration.
    for (const dropped of ['promptText', 'negativeText', 'seed', 'model', 'sampler',
      'steps', 'cfg', 'width', 'height', 'scheduler', 'denoise',
      'lengthFrames', 'fps', 'batchSize']) {
      expect(cols).not.toContain(dropped);
    }
    const rows = db.prepare('SELECT COUNT(*) AS c FROM gallery').get() as { c: number };
    expect(rows.c).toBe(0);
    const flag = db.prepare('SELECT v FROM _meta WHERE k = ?').get('gallery_wave_f_reset') as
      | { v: string } | undefined;
    expect(flag?.v).toBe('done');

    // ---- Insert a row, close, reopen: migration should NOT re-wipe ----
    db.prepare(
      `INSERT INTO gallery (id, filename, mediaType, createdAt, url) VALUES (?, ?, ?, ?, ?)`,
    ).run('fresh-row', 'fresh.png', 'image', 9999, '/api/view?filename=fresh.png');
    resetForTests();
    const db2 = getDb();
    const count = (db2.prepare('SELECT COUNT(*) AS c FROM gallery').get() as { c: number }).c;
    expect(count).toBe(1);
    resetForTests();

    delete process.env.STUDIO_SQLITE_PATH;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('fresh DB: schema already has Wave F cols + _meta flag stamped on first boot', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studio-fresh-'));
    const dbPath = path.join(dir, 'studio.db');
    process.env.STUDIO_SQLITE_PATH = dbPath;
    resetForTests();
    const db = getDb();
    expect(pragmaCols(db, 'gallery')).toContain('workflowJson');
    const flag = db.prepare('SELECT v FROM _meta WHERE k = ?').get('gallery_wave_f_reset') as
      | { v: string } | undefined;
    expect(flag?.v).toBe('done');
    resetForTests();
    delete process.env.STUDIO_SQLITE_PATH;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
