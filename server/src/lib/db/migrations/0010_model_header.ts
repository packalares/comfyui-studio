// Adds measured model-understanding columns to `model_files`, populated by the
// header-parse enrich pass (services/models/header/enrich.ts) from safetensors/
// GGUF headers — architecture family, role, precision/quant, param count and an
// integrity verdict. All nullable and additive; existing rows are backfilled
// lazily on the next scan. `header_scanned_at` + `header_size` drive the
// incremental re-parse (re-read a file's header only when it's new or changed).

import type Database from 'better-sqlite3';

const COLUMNS: Array<[string, string]> = [
  ['arch_family', 'TEXT'],
  ['arch_source', 'TEXT'],
  ['arch_confidence', 'REAL'],
  ['role', 'TEXT'],
  ['precision', 'TEXT'],
  ['quantization', 'TEXT'],
  ['param_count', 'INTEGER'],
  ['is_bundled', 'INTEGER'],
  ['integrity', 'TEXT'],
  ['integrity_note', 'TEXT'],
  ['signals', 'TEXT'],
  ['header_scanned_at', 'INTEGER'],
  ['header_size', 'INTEGER'],
];

export function applyModelHeaderMigration(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_files'`)
    .get();
  if (!exists) return; // schema.ts creates it first; nothing to alter yet

  const have = new Set(
    (db.prepare(`PRAGMA table_info(model_files)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, decl] of COLUMNS) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE model_files ADD COLUMN ${name} ${decl}`);
    }
  }
  // Index for the enrich pass's "needs (re)scan" query and for filtering by
  // integrity/family on the Models/Cleanup pages.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_files_header_scan ON model_files(header_scanned_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_model_files_arch_family ON model_files(arch_family)`);
}
