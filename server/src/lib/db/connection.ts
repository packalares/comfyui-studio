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
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { paths } from '../../config/paths.js';
import { safeResolve } from '../fs.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { applyApiKeysMigration } from './migrations/0001_api_keys.js';
import { workflowHash } from '../workflowHash.js';
import { extractMetadata, type ApiPrompt } from '../../services/gallery/extract.js';

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
 * Schema v15 adds provenance + fingerprint columns to `gallery`.
 *
 * Provenance (three nullable TEXT columns):
 *   triggered_by    — 'ui' | 'chat' | 'mcp' | NULL (legacy rows)
 *   conversation_id — chat conversation id when triggered_by='chat'
 *   message_id      — chat message id when triggered_by='chat'
 *
 * Fingerprinting (two nullable TEXT columns):
 *   model_fingerprint — compact JSON: { "filename.safetensors": "size-mtime" }
 *   template_hash     — sha1(workflow_json).slice(0,16) at submit time
 *
 * All five are additive nullable columns — existing rows get NULL, no data loss.
 */
function applyGalleryProvenanceFingerprintMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(gallery)').all() as Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  const needed: Array<{ name: string; decl: string }> = [
    { name: 'triggered_by',    decl: 'TEXT' },
    { name: 'conversation_id', decl: 'TEXT' },
    { name: 'message_id',      decl: 'TEXT' },
    { name: 'model_fingerprint', decl: 'TEXT' },
    { name: 'template_hash',   decl: 'TEXT' },
  ];
  for (const col of needed) {
    if (!present.has(col.name)) {
      db.exec(`ALTER TABLE gallery ADD COLUMN ${col.name} ${col.decl}`);
    }
  }
}

/**
 * Schema v14 adds `pinned` to `conversations`. Default 0 (false) so all
 * existing rows remain unpinned after migration. The sort order in
 * `listConversations` uses `pinned DESC, updated_at DESC` so pinned rows
 * always float to the top regardless of date group.
 */
function applyConversationsPinnedMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('pinned')) {
    db.exec(
      'ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0',
    );
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

/**
 * Schema v16 adds `soul_name` to `conversations`. Stores the soul slug chosen
 * at conversation creation so re-resolution on each turn picks up memory
 * updates while keeping the soul identity stable for the life of the chat.
 * The companion `system_prompt` snapshot column was dropped in v17 — see
 * `applyConversationsDropSystemPromptMigration` below.
 */
function applyConversationsSoulNameMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('soul_name')) {
    db.exec('ALTER TABLE conversations ADD COLUMN soul_name TEXT');
  }
}

/**
 * Schema v17 drops `system_prompt` from `conversations`. The column was a
 * snapshot of the resolved soul body at creation time, but every read path
 * already re-resolves through `soul_name` (so memory updates propagate). The
 * snapshot was dead weight — drop it and backfill any pre-v16 rows with
 * `soul_name = 'default'` so re-resolution has something to point at.
 * SQLite 3.35+ supports `ALTER TABLE ... DROP COLUMN`.
 */
function applyConversationsDropSystemPromptMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(conversations)').all() as
    Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (present.has('soul_name')) {
    db.exec("UPDATE conversations SET soul_name = 'default' WHERE soul_name IS NULL");
  }
  if (present.has('system_prompt')) {
    db.exec('ALTER TABLE conversations DROP COLUMN system_prompt');
  }
}

/**
 * Schema v19 adds `favorite` to `templates`. Default 0 so existing rows are
 * unpinned after migration. Only `setFavorite` writes the column — `writeRow`'s
 * ON CONFLICT update deliberately omits it, so a catalog re-seed at boot or a
 * `/templates/refresh` preserves the user's pins.
 */
function applyTemplatesFavoriteMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(templates)').all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table created above by SCHEMA_SQL
  const present = new Set(cols.map(c => c.name));
  if (!present.has('favorite')) {
    // ALTER must come before the index — on an existing DB the column isn't
    // there yet, which is also why SCHEMA_SQL can't index `favorite` directly.
    db.exec('ALTER TABLE templates ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_templates_favorite ON templates(favorite)');
}

/**
 * Schema v20 adds three provenance columns to `prompt_snapshots`:
 * `triggered_by`, `conversation_id`, `message_id`. The snapshot becomes the
 * durable store for these fields so gallery hydration can recover them even
 * after the in-memory PromptMeta is cleared.
 */
function applyPromptSnapshotsProvenanceMigration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(prompt_snapshots)').all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table not created yet (handled by SCHEMA_SQL above)
  const present = new Set(cols.map(c => c.name));
  if (!present.has('triggered_by')) {
    db.exec('ALTER TABLE prompt_snapshots ADD COLUMN triggered_by TEXT');
  }
  if (!present.has('conversation_id')) {
    db.exec('ALTER TABLE prompt_snapshots ADD COLUMN conversation_id TEXT');
  }
  if (!present.has('message_id')) {
    db.exec('ALTER TABLE prompt_snapshots ADD COLUMN message_id TEXT');
  }
}

/**
 * Schema v21: drop the 14 extracted-metadata columns from `gallery`, rename
 * `durationMs` to `jobDurationMs`, add `mediaDurationMs` + `mediaInfoJson`,
 * switch live-pipeline IDs to plain UUIDs, and create the new indexes. All
 * steps are idempotent via PRAGMA table_info / CREATE INDEX IF NOT EXISTS /
 * _meta guards.
 */
function applyGallerySchemaV21Migration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(gallery)').all() as Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));

  // Step 1: rename durationMs → jobDurationMs (one ALTER per column; SQLite
  // supports RENAME COLUMN since 3.25 and better-sqlite3 bundles ≥3.45).
  if (present.has('durationMs') && !present.has('jobDurationMs')) {
    db.exec('ALTER TABLE gallery RENAME COLUMN durationMs TO jobDurationMs');
    present.delete('durationMs');
    present.add('jobDurationMs');
  }

  // Step 2: drop the 14 extracted-metadata columns. Per-column catch so a
  // single failure (e.g. version too old to DROP COLUMN) doesn't abort the
  // rest. SQLite DROP COLUMN is supported since 3.35.0.
  const EXTRACTED_COLS = [
    'promptText', 'negativeText', 'seed', 'model', 'sampler',
    'steps', 'cfg', 'width', 'height', 'scheduler', 'denoise',
    'lengthFrames', 'fps', 'batchSize',
  ];
  for (const col of EXTRACTED_COLS) {
    if (!present.has(col)) continue;
    try {
      db.exec(`ALTER TABLE gallery DROP COLUMN ${col}`);
    } catch (err) {
      // Log but continue; the column will simply stay (safe to read, no inserts).
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[v21 migration] could not drop column ${col}: ${msg}`);
    }
  }

  // Step 3: add new inspection columns idempotently.
  const cols2 = db.prepare('PRAGMA table_info(gallery)').all() as Array<{ name: string }>;
  const present2 = new Set(cols2.map(c => c.name));
  if (!present2.has('mediaDurationMs')) {
    db.exec('ALTER TABLE gallery ADD COLUMN mediaDurationMs INTEGER');
  }
  if (!present2.has('mediaInfoJson')) {
    db.exec('ALTER TABLE gallery ADD COLUMN mediaInfoJson TEXT');
  }

  // Step 4: re-ID live-pipeline rows to plain UUIDs. Guarded by _meta so it
  // runs once per DB file. Disk-sweep IDs start with `disk-` and are left
  // alone. Stale browser URLs that held the old composite IDs will 404 —
  // acceptable per design.
  const uuidFlag = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('gallery_id_uuid_v21') as { v: string } | undefined;
  if (!uuidFlag) {
    db.exec(`
      UPDATE gallery
      SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
               lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
               lower(hex(randomblob(6)))
      WHERE id NOT LIKE 'disk-%'
    `);
    db.prepare('INSERT OR REPLACE INTO _meta (k, v) VALUES (?, ?)').run('gallery_id_uuid_v21', 'done');
  }

  // Step 5: drop old durationMs index (if it survived), create new ones.
  db.exec('DROP INDEX IF EXISTS idx_gallery_durationMs');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_jobDurationMs ON gallery(jobDurationMs)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_mediaDurationMs ON gallery(mediaDurationMs)');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_unique_promptid_path
    ON gallery(promptId, subfolder, filename)
    WHERE promptId IS NOT NULL AND promptId != ''
  `);
}

/**
 * One-shot data migration: rewrite legacy disk-sweep ids that contain `/`
 * (the original `disk:<subfolder>/<filename>` shape) to the new URL-safe
 * `disk-<uuid>` form. The slash in the legacy id broke every
 * `/api/gallery/:id`-style route once a reverse proxy decoded `%2F` to `/`
 * before reaching Express. Guarded on `_meta` so it runs once per DB.
 */
function applyDiskSweepIdMigration(db: DB): void {
  const flag = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('disk_sweep_id_v2') as { v: string } | undefined;
  if (flag) return;
  const rows = db.prepare("SELECT id FROM gallery WHERE id LIKE 'disk:%'").all() as
    Array<{ id: string }>;
  if (rows.length > 0) {
    const update = db.prepare('UPDATE gallery SET id = ? WHERE id = ?');
    const tx = db.transaction((items: typeof rows) => {
      for (const r of items) update.run(`disk-${randomUUID()}`, r.id);
    });
    tx(rows);
  }
  db.prepare('INSERT INTO _meta (k, v) VALUES (?, ?)').run('disk_sweep_id_v2', 'done');
}

/**
 * Schema v22 adds `favorite` to `gallery`. Default 0 so existing rows are
 * unfavorited after migration. Only `setFavorite` writes the column —
 * insertGalleryRow's COALESCE upgrade deliberately omits it, so a metadata
 * backfill at disk-sweep time never overwrites the user's pins.
 */
function applyGalleryFavoriteV22Migration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(gallery)').all() as Array<{ name: string }>;
  if (cols.some(c => c.name === 'favorite')) return;
  db.exec('ALTER TABLE gallery ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_favorite ON gallery(favorite)');
}

/**
 * Schema v23 adds `source_type` and `soft_deleted` to `templates`.
 *
 * source_type (INTEGER NOT NULL DEFAULT 0):
 *   0 = unknown (legacy rows — treated as comfy-catalog for compat)
 *   1 = comfy-catalog (imported via import-from-comfy)
 *   2 = civitai
 *   3 = github
 *   4 = upload (paste / file upload)
 *
 * soft_deleted (INTEGER NOT NULL DEFAULT 0):
 *   0 = visible, 1 = hidden (comfy-catalog soft-delete)
 *   Only set by the DELETE endpoint for source_type ∈ {0, 1}.
 *   A soft-deleted row is excluded from the cache; its JSON file is removed
 *   from disk. On re-import, if soft_deleted=1 the row is skipped so the
 *   user's explicit hide decision is respected.
 */
function applyTemplatesV23Migration(db: DB): void {
  const cols = db.prepare('PRAGMA table_info(templates)').all() as Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));
  if (!present.has('source_type')) {
    db.exec('ALTER TABLE templates ADD COLUMN source_type INTEGER NOT NULL DEFAULT 0');
  }
  if (!present.has('soft_deleted')) {
    db.exec('ALTER TABLE templates ADD COLUMN soft_deleted INTEGER NOT NULL DEFAULT 0');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_templates_softdel ON templates(soft_deleted)');
}

/**
 * Schema v24: DB-first templates layer.
 *
 * Adds the metadata columns the in-memory cache used to carry
 * (thumbnail_json, media_type, open_source, search_rank, username), drops the
 * vestigial workflow_json and source columns (never read), adds sort/filter
 * indexes, and backfills the new columns from the user-workflows/ disk JSONs.
 *
 * Idempotent — guarded by `PRAGMA user_version` via the `_meta` table check.
 */
/**
 * Schema v25 adds five tables for the Videoboard (music-video maker) feature:
 *   - videoboard_projects  — top-level project row
 *   - videoboard_shots     — per-shot rows (FK → projects, CASCADE DELETE)
 *   - videoboard_analyses  — audio analysis cache (FK → projects, CASCADE DELETE)
 *   - videoboard_characters — saved PuLID / LoRA character identities
 *   - videoboard_jobs      — async job tracking (FK → projects, CASCADE DELETE)
 *
 * All JSON-compound columns (character_ids, settings, lyrics_json, etc.) are
 * stored as TEXT and deserialized in the repo layer. Runs once, guarded on
 * `_meta` key `videoboard_v25`.
 */
function applyVideoboardV25Migration(db: DB): void {
  const done = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('videoboard_v25') as { v: string } | undefined;
  if (done) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS videoboard_projects (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      audio_path        TEXT,
      audio_duration_ms INTEGER,
      analysis_status   TEXT NOT NULL DEFAULT 'none',
      character_ids     TEXT NOT NULL DEFAULT '[]',
      settings          TEXT NOT NULL DEFAULT '{}',
      status            TEXT NOT NULL DEFAULT 'draft',
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videoboard_shots (
      project_id TEXT NOT NULL REFERENCES videoboard_projects(id) ON DELETE CASCADE,
      idx        INTEGER NOT NULL,
      start_ms   INTEGER NOT NULL DEFAULT 0,
      end_ms     INTEGER NOT NULL DEFAULT 0,
      lyrics     TEXT NOT NULL DEFAULT '',
      prompt     TEXT NOT NULL DEFAULT '',
      seed       INTEGER NOT NULL DEFAULT 0,
      image_url  TEXT,
      video_url  TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      PRIMARY KEY (project_id, idx)
    );

    CREATE TABLE IF NOT EXISTS videoboard_analyses (
      project_id    TEXT PRIMARY KEY REFERENCES videoboard_projects(id) ON DELETE CASCADE,
      bpm           REAL,
      energy        REAL,
      lyrics_json   TEXT NOT NULL DEFAULT '[]',
      sections_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS videoboard_characters (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      kind             TEXT NOT NULL DEFAULT 'pulid',
      base_model       TEXT NOT NULL DEFAULT 'flux1-dev',
      ref_photos_json  TEXT NOT NULL DEFAULT '[]',
      pulid_embed_path TEXT,
      lora_path        TEXT,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS videoboard_jobs (
      id         TEXT PRIMARY KEY,
      project_id TEXT REFERENCES videoboard_projects(id) ON DELETE CASCADE,
      shot_idx   INTEGER,
      kind       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'queued',
      progress   REAL NOT NULL DEFAULT 0,
      message    TEXT,
      output_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_vb_projects_created   ON videoboard_projects(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vb_shots_project      ON videoboard_shots(project_id);
    CREATE INDEX IF NOT EXISTS idx_vb_jobs_project       ON videoboard_jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_vb_jobs_status        ON videoboard_jobs(status);
  `);

  db.prepare('INSERT OR REPLACE INTO _meta (k, v) VALUES (?, ?)').run('videoboard_v25', 'done');
}

/**
 * Schema v26 adds `metadata_json` to `videoboard_analyses` so the new
 * extended analysis fields (bpmMin, bpmMax, tempoTag, timeSignature,
 * audioMeta, summary, emotions, keywords, genre, mood) can be persisted
 * without further schema changes. Guarded on `_meta` key `videoboard_v26`.
 */
function applyVideoboardV26Migration(db: DB): void {
  const done = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('videoboard_v26') as { v: string } | undefined;
  if (done) return;
  const cols = db.prepare('PRAGMA table_info(videoboard_analyses)').all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table not yet created (handled by v25)
  if (!cols.some(c => c.name === 'metadata_json')) {
    db.exec('ALTER TABLE videoboard_analyses ADD COLUMN metadata_json TEXT');
  }
  db.prepare('INSERT OR REPLACE INTO _meta (k, v) VALUES (?, ?)').run('videoboard_v26', 'done');
}

/**
 * Schema v27 adds `analysis_json` to `videoboard_analyses`. The new pipeline
 * (OMNI_AUDIO_Analyze) emits the whole analysis as one JSON blob; we store
 * it verbatim so the DB shape and the analyzer output stay byte-identical.
 * The legacy columns (bpm/energy/lyrics_json/sections_json/metadata_json)
 * are left in place but no longer read or written — old rows are orphaned
 * and getAnalysis returns null for them, forcing a re-analyze. Guarded on
 * `_meta` key `videoboard_v27`.
 */
function applyVideoboardV27Migration(db: DB): void {
  const done = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('videoboard_v27') as { v: string } | undefined;
  if (done) return;
  const cols = db.prepare('PRAGMA table_info(videoboard_analyses)').all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table not yet created (handled by v25)
  if (!cols.some(c => c.name === 'analysis_json')) {
    db.exec('ALTER TABLE videoboard_analyses ADD COLUMN analysis_json TEXT');
  }
  db.prepare('INSERT OR REPLACE INTO _meta (k, v) VALUES (?, ?)').run('videoboard_v27', 'done');
}

/**
 * Schema v28 adds `scene_json TEXT` to `videoboard_shots`. The Director
 * (OMNI_AUDIO_VideoScenes) emits richer per-shot data than the legacy
 * mock-shot schema (image_prompt, video_prompt, key_visual, treatment
 * snapshot, chunk_idx); rather than add five columns each time the schema
 * evolves, we serialize the new fields into one TEXT blob. The existing
 * columns (start_ms/end_ms/lyrics/prompt/seed/image_url/video_url/status)
 * still hold the cross-cutting shot state. Guarded on `_meta` key
 * `videoboard_v28`.
 */
function applyVideoboardV28Migration(db: DB): void {
  const done = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('videoboard_v28') as { v: string } | undefined;
  if (done) return;
  const cols = db.prepare('PRAGMA table_info(videoboard_shots)').all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table not yet created (handled by v25)
  if (!cols.some(c => c.name === 'scene_json')) {
    db.exec('ALTER TABLE videoboard_shots ADD COLUMN scene_json TEXT');
  }
  db.prepare('INSERT OR REPLACE INTO _meta (k, v) VALUES (?, ?)').run('videoboard_v28', 'done');
}

function applyTemplatesV24Migration(db: DB): void {
  const done = db.prepare('SELECT v FROM _meta WHERE k = ?')
    .get('templates_v24') as { v: string } | undefined;
  if (done) return;

  const cols = db.prepare('PRAGMA table_info(templates)').all() as Array<{ name: string }>;
  const present = new Set(cols.map(c => c.name));

  // Add new columns if they don't already exist (fresh DBs have them from SCHEMA_SQL).
  if (!present.has('thumbnail_json')) {
    db.exec('ALTER TABLE templates ADD COLUMN thumbnail_json TEXT');
  }
  if (!present.has('media_type')) {
    db.exec('ALTER TABLE templates ADD COLUMN media_type TEXT');
  }
  if (!present.has('open_source')) {
    db.exec('ALTER TABLE templates ADD COLUMN open_source INTEGER NOT NULL DEFAULT 1');
  }
  if (!present.has('search_rank')) {
    db.exec('ALTER TABLE templates ADD COLUMN search_rank INTEGER NOT NULL DEFAULT 0');
  }
  if (!present.has('username')) {
    db.exec('ALTER TABLE templates ADD COLUMN username TEXT');
  }

  // Drop vestigial columns on SQLite 3.35+. Failures are caught per-column
  // so an older SQLite doesn't abort the entire migration.
  for (const col of ['workflow_json', 'source'] as const) {
    if (present.has(col)) {
      try {
        db.exec(`ALTER TABLE templates DROP COLUMN ${col}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[v24 migration] could not drop column ${col}: ${msg}`);
      }
    }
  }

  // Sort + filter indexes.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_templates_sort
      ON templates(search_rank DESC, displayName);
    CREATE INDEX IF NOT EXISTS idx_templates_filter
      ON templates(soft_deleted, category, source_type);
  `);

  // One-shot backfill from disk JSONs.
  const dir: string = paths.userTemplatesDir;
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(
      (n: string) => n.endsWith('.json') && !n.endsWith('.meta.json'),
    );
    const upd = db.prepare(`
      UPDATE templates SET
        thumbnail_json = COALESCE(@thumbnail_json, thumbnail_json),
        media_type     = COALESCE(@media_type, media_type),
        open_source    = COALESCE(@open_source, open_source),
        search_rank    = COALESCE(@search_rank, search_rank),
        username       = COALESCE(@username, username)
      WHERE name = @name
    `);
    for (const f of files) {
      const safe = f.replace(/\.json$/, '');
      if (!/^[a-z0-9_.-]+$/i.test(safe)) continue;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(dir, f), 'utf8'),
        ) as Record<string, unknown>;
        upd.run({
          name: safe,
          thumbnail_json: Array.isArray(data.thumbnail) ? JSON.stringify(data.thumbnail) : null,
          media_type: (typeof data.mediaType === 'string' ? data.mediaType : null),
          open_source: data.openSource === false ? 0 : 1,
          search_rank: typeof data.searchRank === 'number' ? data.searchRank : null,
          username: (typeof data.username === 'string' ? data.username : null),
        });
      } catch { /* skip malformed; row keeps defaults */ }
    }
  }

  db.prepare('INSERT OR REPLACE INTO _meta (k, v) VALUES (?, ?)').run('templates_v24', 'done');
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
  applyConversationsPinnedMigration(db);
  applyGalleryProvenanceFingerprintMigration(db);
  applyConversationsSoulNameMigration(db);
  applyConversationsDropSystemPromptMigration(db);
  applyTemplatesFavoriteMigration(db);
  applyPromptSnapshotsProvenanceMigration(db);
  applyDiskSweepIdMigration(db);
  applyGallerySchemaV21Migration(db);
  applyGalleryFavoriteV22Migration(db);
  applyTemplatesV23Migration(db);
  applyTemplatesV24Migration(db);
  applyVideoboardV25Migration(db);
  applyVideoboardV26Migration(db);
  applyVideoboardV27Migration(db);
  applyVideoboardV28Migration(db);
  applyApiKeysMigration(db);
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
