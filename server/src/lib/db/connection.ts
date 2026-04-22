// Shared better-sqlite3 connection for the single studio.db file.
//
// Consumers never new-up Database themselves; they go through `getDb()`.
// The first call creates the parent directory, opens the file, enables WAL
// + foreign-keys pragmas, creates the schema if absent and stamps
// `schema_version`. Every subsequent call returns the cached handle.
//
// `resetForTests()` closes the handle and clears the cache so vitest can
// run each test against a fresh tmpdir-pointed DB. Production code never
// calls it.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../fs.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { workflowHash } from '../workflowHash.js';
import { extractMetadata, type ApiPrompt } from '../../services/gallery.extract.js';

type DB = Database.Database;

let cached: DB | null = null;
let cachedPath: string | null = null;

/**
 * Resolve the target sqlite path under the runtime-state dir, blocking any
 * attempt (via env override) to escape the allowed roots. Tests get to use
 * their tmpdir because we permit the file to live either under
 * `runtimeStateDir` or under `os.tmpdir()`.
 */
function resolveDbPath(): string {
  const target = paths.sqlitePath;
  // Confirm the directory is creatable and the final path is absolute.
  const abs = path.resolve(target);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Defence-in-depth: the file MUST resolve to itself under its own
  // directory — i.e. no `..` games once the caller-provided value is
  // normalised. safeResolve throws on escape.
  safeResolve(dir, path.basename(abs));
  return abs;
}

/**
 * Idempotent additive migration for the Wave F gallery metadata columns.
 * Pre-existing databases were created before `workflowJson` / prompt /
 * sampler fields existed; the CREATE TABLE above only runs on a fresh file,
 * so we ALTER-TABLE-ADD-COLUMN any missing ones here. `PRAGMA table_info`
 * is the canonical way to introspect sqlite columns.
 *
 * After the columns are in place, we do a one-shot wipe of the gallery
 * table to clear "zombie" rows resurrected by the pre-Wave-F rescan bug.
 * The one-shot flag lives in `_meta` so subsequent boots skip it.
 */
function applyGalleryWaveFMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(gallery)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  const needed: Array<{ name: string; decl: string }> = [
    { name: 'workflowJson', decl: 'TEXT' },
    { name: 'promptText',   decl: 'TEXT' },
    { name: 'negativeText', decl: 'TEXT' },
    { name: 'seed',         decl: 'INTEGER' },
    { name: 'model',        decl: 'TEXT' },
    { name: 'sampler',      decl: 'TEXT' },
    { name: 'steps',        decl: 'INTEGER' },
    { name: 'cfg',          decl: 'REAL' },
    { name: 'width',        decl: 'INTEGER' },
    { name: 'height',       decl: 'INTEGER' },
    { name: 'workflowHash', decl: 'TEXT' },
    // Schema v4: workflow-agnostic extractor output.
    { name: 'scheduler',    decl: 'TEXT' },
    { name: 'denoise',      decl: 'REAL' },
    { name: 'lengthFrames', decl: 'INTEGER' },
    { name: 'fps',          decl: 'REAL' },
    { name: 'batchSize',    decl: 'INTEGER' },
    { name: 'durationMs',   decl: 'INTEGER' },
    { name: 'modelsJson',   decl: 'TEXT' },
  ];
  for (const col of needed) {
    if (!present.has(col.name)) {
      db.exec(`ALTER TABLE gallery ADD COLUMN ${col.name} ${col.decl}`);
    }
  }
  // Backfill workflowHash for rows that have workflowJson but no hash yet.
  // One-shot per DB file (idempotent since we filter on NULL hash). Needed
  // after the v2→v3 bump so cache-hit lookups find pre-existing rows.
  const missing = db.prepare(
    'SELECT id, workflowJson FROM gallery WHERE workflowJson IS NOT NULL AND workflowHash IS NULL',
  ).all() as Array<{ id: string; workflowJson: string }>;
  if (missing.length > 0) {
    const update = db.prepare('UPDATE gallery SET workflowHash = ? WHERE id = ?');
    const tx = db.transaction((rows: typeof missing) => {
      for (const r of rows) {
        try {
          const parsed = JSON.parse(r.workflowJson) as unknown;
          const hash = workflowHash(parsed);
          if (hash) update.run(hash, r.id);
        } catch { /* malformed workflowJson — skip */ }
      }
    });
    tx(missing);
  }
  // One-shot wipe of pre-migration "zombie" gallery rows left behind by the
  // original (pre-workflowJson) rescan bug. Guarded on _meta so we never
  // re-run this on subsequent boots.
  //
  // The flag key is `gallery_wave_f_reset` for historical reasons (the
  // cleanup shipped in the "Wave F" gallery migration). Renaming it would
  // make existing pods re-wipe their gallery on the next boot — so the key
  // name is load-bearing even though the wave terminology is long gone.
  const flag = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('gallery_wave_f_reset') as { v: string } | undefined;
  if (!flag) {
    db.exec('DELETE FROM gallery');
    db.prepare('INSERT INTO _meta (k, v) VALUES (?, ?)')
      .run('gallery_wave_f_reset', 'done');
  }

  // v4 indexes: idempotent, run after the ALTERs so `durationMs` exists on
  // legacy DBs by the time we try to index it.
  db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_durationMs ON gallery(durationMs)');

  // v4 backfill: for rows with workflowJson but no modelsJson, re-run the
  // (workflow-agnostic) extractor to populate the new columns. Guarded in
  // `_meta` so subsequent boots skip it.
  const backfillDone = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('gallery_schema_v4_backfill') as { v: string } | undefined;
  if (!backfillDone) {
    const rows = db.prepare(
      'SELECT id, workflowJson FROM gallery WHERE workflowJson IS NOT NULL AND modelsJson IS NULL',
    ).all() as Array<{ id: string; workflowJson: string }>;
    const update = db.prepare(`
      UPDATE gallery SET
        scheduler    = COALESCE(scheduler,    ?),
        denoise      = COALESCE(denoise,      ?),
        lengthFrames = COALESCE(lengthFrames, ?),
        fps          = COALESCE(fps,          ?),
        batchSize    = COALESCE(batchSize,    ?),
        modelsJson   = ?
      WHERE id = ?
    `);
    const tx = db.transaction((items: typeof rows) => {
      for (const r of items) {
        try {
          const parsed = JSON.parse(r.workflowJson) as ApiPrompt;
          const meta = extractMetadata(parsed);
          update.run(
            meta.scheduler, meta.denoise, meta.length, meta.fps, meta.batchSize,
            JSON.stringify(meta.models ?? []), r.id,
          );
        } catch { /* malformed workflowJson — skip */ }
      }
    });
    tx(rows);
    db.prepare('INSERT INTO _meta (k, v) VALUES (?, ?)')
      .run('gallery_schema_v4_backfill', 'done');
  }
}

function openAndInit(dbPath: string): DB {
  const db = new Database(dbPath);
  // WAL: many readers + single writer, durable across crashes, and the
  // expected mode for server workloads.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyGalleryWaveFMigration(db);
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
  } else if (row.version < SCHEMA_VERSION) {
    // v1 -> v2 is additive (CREATE TABLE IF NOT EXISTS already ran); just
    // stamp the new version so subsequent boots short-circuit the check.
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  }
  return db;
}

export function getDb(): DB {
  if (cached && cachedPath === paths.sqlitePath) return cached;
  // If the underlying path changed (test-scoped override), drop the old handle.
  if (cached) { try { cached.close(); } catch { /* ignore */ } cached = null; }
  const dbPath = resolveDbPath();
  cached = openAndInit(dbPath);
  cachedPath = paths.sqlitePath;
  return cached;
}

/** Close and forget the cached DB. Intended for vitest setup/teardown. */
export function resetForTests(): void {
  if (cached) { try { cached.close(); } catch { /* ignore */ } }
  cached = null;
  cachedPath = null;
}

/** Read the current stamped schema_version. Returns 0 when the row is absent. */
export function getSchemaVersion(db: DB = getDb()): number {
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number } | undefined;
  return row?.version ?? 0;
}
