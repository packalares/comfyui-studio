// Tests: v32 recipes migration creates the table with correct columns.

import { describe, it, expect } from 'vitest';
import { makeFreshDbFixture } from './_helpers.js';
import { getDb } from '../../../src/lib/db/connection.js';
import { getSchemaVersion } from '../../../src/lib/db/connection.js';
import { SCHEMA_VERSION } from '../../../src/lib/db/schema.js';

describe('recipes migration (v32)', () => {
  it('creates the recipes table with expected columns', () => {
    const fix = makeFreshDbFixture();
    try {
      const db = getDb();
      const cols = db.prepare('PRAGMA table_info(recipes)').all() as Array<{ name: string; type: string; notnull: number }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('id');
      expect(names).toContain('title');
      expect(names).toContain('notes');
      expect(names).toContain('tags_json');
      expect(names).toContain('loras_json');
      expect(names).toContain('created_at');
      expect(names).toContain('updated_at');

      const titleCol = cols.find((c) => c.name === 'title');
      expect(titleCol?.notnull).toBe(1);

      const lorasCol = cols.find((c) => c.name === 'loras_json');
      expect(lorasCol?.notnull).toBe(1);
    } finally {
      fix.cleanup();
    }
  });

  it('creates the idx_recipes_title index', () => {
    const fix = makeFreshDbFixture();
    try {
      const db = getDb();
      const indexes = db.prepare("PRAGMA index_list(recipes)").all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain('idx_recipes_title');
    } finally {
      fix.cleanup();
    }
  });

  // Asserts against the SCHEMA_VERSION constant rather than a literal: the
  // point is that migrating a fresh DB lands on the *declared* version, which
  // stays true as migrations are added. This previously hardcoded `32` and had
  // been failing since a later migration bumped the constant past it.
  it('migrates a fresh db to the current schema version', () => {
    const fix = makeFreshDbFixture();
    try {
      const version = getSchemaVersion();
      expect(version).toBe(SCHEMA_VERSION);
    } finally {
      fix.cleanup();
    }
  });
});
