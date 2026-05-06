// Migration test — verifies new v15 columns appear on fresh DBs, and that
// getDb() works without errors on a fresh file (no pre-existing rows to lose).

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getDb, resetForTests } from '../../../src/lib/db/connection.js';

function pragmaCols(table: string): string[] {
  const db = getDb();
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(c => c.name);
}

const NEW_GALLERY_COLS = [
  'triggered_by', 'conversation_id', 'message_id',
  'model_fingerprint', 'template_hash',
];

describe('v15 provenance + fingerprint migration', () => {
  it('fresh DB: new gallery cols present, NULL on all new fields for fresh rows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studio-v15-fresh-'));
    const dbPath = path.join(dir, 'studio.db');
    process.env.STUDIO_SQLITE_PATH = dbPath;
    resetForTests();

    const cols = pragmaCols('gallery');
    for (const col of NEW_GALLERY_COLS) expect(cols).toContain(col);

    // Insert a row and verify all new fields are NULL by default.
    const db = getDb();
    db.prepare(
      'INSERT INTO gallery (id, filename, mediaType, createdAt, url) VALUES (?, ?, ?, ?, ?)',
    ).run('r1', 'f.png', 'image', 1000, '/api/view?filename=f.png');
    const row = db.prepare(
      'SELECT triggered_by, conversation_id, message_id, model_fingerprint, template_hash FROM gallery WHERE id = ?',
    ).get('r1') as Record<string, unknown>;
    expect(row.triggered_by).toBeNull();
    expect(row.conversation_id).toBeNull();
    expect(row.message_id).toBeNull();
    expect(row.model_fingerprint).toBeNull();
    expect(row.template_hash).toBeNull();

    resetForTests();
    delete process.env.STUDIO_SQLITE_PATH;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('fresh DB: prompt_snapshots table has required columns + index', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studio-v15-snap-'));
    const dbPath = path.join(dir, 'studio.db');
    process.env.STUDIO_SQLITE_PATH = dbPath;
    resetForTests();

    const snapCols = pragmaCols('prompt_snapshots');
    expect(snapCols).toContain('promptId');
    expect(snapCols).toContain('apiPromptJson');
    expect(snapCols).toContain('templateName');
    expect(snapCols).toContain('createdAt');

    // Verify the index exists.
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='prompt_snapshots'",
    ).all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_prompt_snapshots_createdAt');

    resetForTests();
    delete process.env.STUDIO_SQLITE_PATH;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
