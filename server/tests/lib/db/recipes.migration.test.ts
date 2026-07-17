// Tests: v32 recipes migration creates the table with correct columns.

import { describe, it, expect } from 'vitest';
import { makeFreshDbFixture } from './_helpers.js';
import { getDb } from '../../../src/lib/db/connection.js';
import { getSchemaVersion } from '../../../src/lib/db/connection.js';

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

  it('schema version is current (>=32)', () => {
    // Recipes migration was introduced at v32; SCHEMA_VERSION keeps moving
    // up as new migrations land (v33 added templates.template_presets).
    // Assert it never moved backwards rather than pinning a specific number
    // every new migration has to bump here.
    const fix = makeFreshDbFixture();
    try {
      const version = getSchemaVersion();
      expect(version).toBeGreaterThanOrEqual(32);
    } finally {
      fix.cleanup();
    }
  });
});
