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

/**
 * Schema v7 widens `conversations` with `context_strategy` so each chat row
 * carries its own context-window management policy. The column was added
 * before the v13 migration that collapsed the strategies down to
 * 'sliding' / 'auto'; the original three-value vocabulary lived here.
 * Existing DBs were created before the column existed; we add it
 * idempotently here so v6 → v7 boots without a destructive rewrite.
 */
function applyConversationsContextStrategyMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('context_strategy')) {
    db.exec(
      "ALTER TABLE conversations ADD COLUMN context_strategy TEXT NOT NULL DEFAULT 'sliding'",
    );
  }
}

/**
 * Schema v9 widens `ollama_library` with `updated_ago_sec` so the catalog
 * can be ordered newest-first via a numeric column (the upstream `updated`
 * field is a free-form "X ago" string that's not directly sortable). The
 * default is a large sentinel so rows that haven't been re-scraped yet
 * land at the bottom rather than mixing into the recent set.
 */
/**
 * Schema v10 widens `conversations` with `num_ctx` so each chat row can pin
 * its own runtime context window. NULL means "let Ollama decide" (its
 * built-in default, usually 2048). The send path includes `options.num_ctx`
 * in the request body only when the row carries a non-null value.
 */
function applyConversationsNumCtxMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('num_ctx')) {
    db.exec('ALTER TABLE conversations ADD COLUMN num_ctx INTEGER');
  }
}

/**
 * Schema v11 widens `conversations` with `think_mode` so each chat row can
 * pin reasoning-mode behavior independently. NULL = "auto" (let the model
 * default decide); 'on' / 'off' map to `think: true|false` on the outgoing
 * /api/chat body.
 */
function applyConversationsThinkModeMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('think_mode')) {
    db.exec('ALTER TABLE conversations ADD COLUMN think_mode TEXT');
  }
}

/**
 * Schema v12 widens `conversations` with `temperature` (REAL, nullable) and
 * `format` (TEXT, nullable; values: 'json' or NULL). Both are per-chat
 * runtime overrides — the send path writes `options.temperature` and the
 * top-level `format` field on /api/chat when set.
 *
 * Also adds `chat_messages.load_duration_ms` so the cold-load latency
 * reported by Ollama on the final NDJSON frame can be persisted alongside
 * the existing `ms_total` / `ms_to_first_token` telemetry.
 */
function applyConversationsTemperatureFormatMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('temperature')) {
    db.exec('ALTER TABLE conversations ADD COLUMN temperature REAL');
  }
  if (!present.has('format')) {
    db.exec('ALTER TABLE conversations ADD COLUMN format TEXT');
  }
}

function applyChatMessagesLoadDurationMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(chat_messages)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('load_duration_ms')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN load_duration_ms INTEGER');
  }
}

/**
 * Schema v13 collapses the three-strategy model down to two:
 *   - 'summarize' (in-flight summary, recomputed each send) → 'auto'
 *     (destructive server-side Compact when threshold is hit). The
 *     persisted column value is renamed; the auto path itself reuses
 *     compactConversation() which already exists.
 *   - 'manual' (warn-only, never auto-trim) → 'sliding'. Manual users
 *     who didn't want auto-trim get the gentle path; the destructive
 *     Compact-now button still works as before regardless of the
 *     selected strategy, so they aren't locked out.
 * Idempotent UPDATEs — running this on a fresh DB is a no-op.
 */
function applyContextStrategyV13Migration(db: DB): void {
  db.prepare(
    "UPDATE conversations SET context_strategy = 'auto' WHERE context_strategy = 'summarize'",
  ).run();
  db.prepare(
    "UPDATE conversations SET context_strategy = 'sliding' WHERE context_strategy = 'manual'",
  ).run();
}

function applyOllamaLibraryUpdatedAgoMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(ollama_library)').all() as
    Array<{ name: string }>;
  if (cols.length === 0) return; // table not created yet (handled by SCHEMA_SQL above)
  const present = new Set(cols.map(c => c.name));
  if (!present.has('updated_ago_sec')) {
    db.exec(
      'ALTER TABLE ollama_library ADD COLUMN updated_ago_sec INTEGER NOT NULL DEFAULT 9999999999',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_ollama_library_updated_ago ON ollama_library(updated_ago_sec)');
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
  applyConversationsContextStrategyMigration(db);
  applyConversationsNumCtxMigration(db);
  applyConversationsThinkModeMigration(db);
  applyConversationsTemperatureFormatMigration(db);
  applyChatMessagesLoadDurationMigration(db);
  applyContextStrategyV13Migration(db);
  applyOllamaLibraryUpdatedAgoMigration(db);
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
