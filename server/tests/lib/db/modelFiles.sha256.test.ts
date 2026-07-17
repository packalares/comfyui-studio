// T4: SHA256 column migration + setSha256 + listMissingSha256.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { useFreshDb } from './_helpers.js';
import { getDb } from '../../../src/lib/db/connection.js';
import * as repo from '../../../src/lib/db/modelFiles.repo.js';

useFreshDb();

function insertRow(absPath: string, filename: string, size: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO model_files
      (abs_path, filename, rel_path, root_kind, top_dir, size, status, scanned_at)
    VALUES (?, ?, ?, 'local', 'loras', ?, 'complete', ?)
  `).run(absPath, filename, `loras/${filename}`, size, Date.now());
}

describe('model_files sha256 migration', () => {
  it('sha256 column exists after migration', () => {
    const db = getDb();
    const cols = db.prepare('PRAGMA table_info(model_files)').all() as
      Array<{ name: string }>;
    expect(cols.some(c => c.name === 'sha256')).toBe(true);
  });

  it('newly inserted rows have sha256 = NULL by default', () => {
    insertRow('/models/loras/a.safetensors', 'a.safetensors', 1000);
    const rows = repo.listByFilename('a.safetensors');
    expect(rows).toHaveLength(1);
    expect(rows[0].sha256).toBeNull();
  });
});

describe('setSha256', () => {
  beforeEach(() => {
    insertRow('/models/loras/model.safetensors', 'model.safetensors', 2048);
  });

  it('stores the sha256 for an existing row', () => {
    const sha = 'a'.repeat(64);
    repo.setSha256('/models/loras/model.safetensors', sha);
    const rows = repo.listByFilename('model.safetensors');
    expect(rows[0].sha256).toBe(sha);
  });

  it('is a no-op when abs_path does not exist', () => {
    // Should not throw.
    expect(() => repo.setSha256('/nonexistent/path.safetensors', 'b'.repeat(64))).not.toThrow();
  });

  it('can be updated multiple times', () => {
    repo.setSha256('/models/loras/model.safetensors', 'a'.repeat(64));
    repo.setSha256('/models/loras/model.safetensors', 'b'.repeat(64));
    const rows = repo.listByFilename('model.safetensors');
    expect(rows[0].sha256).toBe('b'.repeat(64));
  });
});

describe('listMissingSha256', () => {
  beforeEach(() => {
    insertRow('/models/loras/big.safetensors', 'big.safetensors', 900000);
    insertRow('/models/loras/small.safetensors', 'small.safetensors', 100);
    insertRow('/models/loras/hashed.safetensors', 'hashed.safetensors', 500);
    repo.setSha256('/models/loras/hashed.safetensors', 'c'.repeat(64));
  });

  it('returns only rows where sha256 IS NULL', () => {
    const missing = repo.listMissingSha256();
    const names = missing.map(r => r.filename);
    expect(names).toContain('big.safetensors');
    expect(names).toContain('small.safetensors');
    expect(names).not.toContain('hashed.safetensors');
  });

  it('returns rows ordered by ascending size (small first)', () => {
    const missing = repo.listMissingSha256();
    const sizes = missing.map(r => r.size ?? 0);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });

  it('respects the limit parameter', () => {
    const missing = repo.listMissingSha256(1);
    expect(missing).toHaveLength(1);
  });

  it('returns abs_path and filename fields', () => {
    const missing = repo.listMissingSha256();
    for (const row of missing) {
      expect(typeof row.abs_path).toBe('string');
      expect(typeof row.filename).toBe('string');
    }
  });
});
