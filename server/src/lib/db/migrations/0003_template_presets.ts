// Schema v33 — `template_presets` TEXT column on `templates`.
//
// Holds a JSON array of preset display cards for templates whose import
// payload carries a `template_presets[]` block (Easy-mode Image / Video /
// Audio builders only). Each card carries id, title, description, the
// LOCAL-rewritten previewUrl (pointing at /api/thumbnail/preset/...),
// `published`, and `tool`. The full per-preset settings block lives on
// disk at `user-workflows/<parent>/<presetId>.json` so the column stays
// thin enough for the bundle response to ship it whole.
//
// Idempotent: PRAGMA pre-check before ALTER, same shape as the existing
// templates Vn migrations. No data loss on existing DBs; fresh DBs get
// the column from SCHEMA_SQL.

import type Database from 'better-sqlite3';

const META_KEY = 'templates_v33_presets';

export function applyTemplatePresetsMigration(db: Database.Database): void {
  const done = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get(META_KEY) as { v: string } | undefined;
  if (done) return;

  const cols = db.prepare('PRAGMA table_info(templates)').all() as Array<{ name: string }>;
  const present = new Set(cols.map((c) => c.name));

  if (!present.has('template_presets')) {
    db.exec('ALTER TABLE templates ADD COLUMN template_presets TEXT');
  }

  db.prepare('INSERT OR REPLACE INTO _meta (k, v) VALUES (?, ?)')
    .run(META_KEY, '1');
}
