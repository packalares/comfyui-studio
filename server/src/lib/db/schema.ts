// SQL DDL for the single studio.db sqlite file.
//
// Tables: gallery, plugins_catalog, templates, template_models, template_plugins,
// _meta (simple kv for one-shot migration flags) plus a `schema_version` guard
// row so future migrations can inspect the current version. Phase 10 bumps the
// version to 2 by appending the template catalog + dep-graph tables (idempotent
// CREATE TABLE IF NOT EXISTS — v1 data is untouched).
//
// Wave F widens `gallery` with per-row generation metadata (workflowJson +
// KSampler params). Columns are added via ALTER TABLE in `connection.ts` so
// pre-existing rows keep working without a full rewrite.
//
// Schema v19 adds `templates.favorite` (user-pinned flag). Added via ALTER
// TABLE in `connection.ts` so existing rows default to 0; `writeRow`'s
// ON CONFLICT update deliberately omits the column so a catalog re-seed /
// refresh preserves the user's pins — only `setFavorite` writes it.
//
// Schema v20 adds three provenance columns to `prompt_snapshots`:
// `triggered_by`, `conversation_id`, `message_id`. The snapshot is now
// the durable source for these three fields; `modelFingerprint` and
// `templateHash` remain in-memory only (recomputable, not persisted).
//
// Schema v21 drops the 14 per-row extracted metadata columns from `gallery`
// (promptText, negativeText, seed, model, sampler, scheduler, steps, cfg,
// denoise, width, height, lengthFrames, fps, batchSize). These are all
// derivable on-the-fly from `workflowJson` via extractMetadata(). Renames
// `durationMs` to `jobDurationMs` (job wall-clock, not media duration), and
// adds `mediaDurationMs` + `mediaInfoJson` for per-file inspection data (sharp
// for images, ffprobe for audio/video). Live-pipeline row IDs switch to plain
// UUIDs. A partial UNIQUE INDEX prevents duplicate (promptId, subfolder,
// filename) combinations for live rows while allowing disk-sweep rows that
// share the same filename to co-exist.
//
// Schema v22 adds `gallery.favorite` (INTEGER NOT NULL DEFAULT 0) so the user
// can pin gallery items server-side. The column is added via ALTER TABLE in
// `connection.ts` (applyGalleryFavoriteV22Migration) so existing rows default
// to 0 without a table rewrite. Only `setFavorite` in gallery.repo.ts writes
// this column — insertGalleryRow's COALESCE upgrade deliberately omits it so
// metadata backfills never overwrite the user's pins.
//
// Indexes are deliberately scoped to the columns we sort or filter on in
// routes (`createdAt`, `mediaType`, `templateName`, `promptId`, `title`,
// `author`, `installed`, `category`, `favorite`, `model_filename`,
// `plugin_id`). Anything else stays unindexed or lives inside `raw_json` /
// `workflow_json`.

// Schema v29 adds `api_keys` for the auth layer. Each row holds a non-secret
// `prefix` (used to identify which key was presented without hashing every
// candidate on every request) and a `hash` of the full plain secret. The plain
// secret is returned exactly once at creation and is never persisted. See
// `lib/auth/keyGen.ts` for the prefix / plain / hash format.
// Schema v30 adds `gallery.enhancedPromptsJson` (TEXT, nullable). Holds a
// JSON map `{<sourceNodeId>: <expandedText>}` populated by the gallery row
// builder when one or more `__studio_enhanced_*` PreviewAny probes (injected
// downstream of every `TextGenerate*` node) fire in ComfyUI's `executed` WS
// event or surface in `/history.outputs`. Multi-enhancer templates record
// one entry per source. The migration also drops the v30-original singleton
// `enhancedPromptText` column on rolling upgrades — no data was captured to
// it before this reshape landed.
//
// Schema v31 adds `model_files.sha256 TEXT` (nullable). No backfill; Wave 3's
// background hasher will populate the column. The migration is applied via
// `applyModelFilesSha256Migration` in connection.ts (ALTER TABLE guarded by
// PRAGMA table_info so existing DBs are safe).
//
// Schema v32 adds the `recipes` table for saved LoRA combinations. Rows hold
// a title, optional notes, a JSON array of tags, and a JSON array of lora
// descriptors ({ filename, save_path, strength }). Migration is applied via
// `applyRecipesMigration` in connection.ts (CREATE TABLE IF NOT EXISTS so
// existing DBs are safe — no data loss on re-run).
//
// Schema v33 adds `templates.template_presets TEXT` — JSON array of preset
// display cards for Easy-mode templates (studioBuilder set). Per-preset
// settings blocks live on disk at `user-workflows/<parent>/<id>.json`; this
// column carries just the card metadata (id, title, description, local
// previewUrl, published, tool) so it stays cheap to ship in the bundle.
// Migration `applyTemplatePresetsMigration` (PRAGMA-guarded ALTER) keeps
// existing DBs safe.
//
// Schema v34 adds the `packs` table for the capability-pack subsystem
// (optional heavy features like ACE-Step music or AI-Toolkit training whose
// pip deps + models install on demand into the persistent volume). Each row
// is just the durable install-state record (installed flag, version,
// install timestamp) keyed by pack id; the pack's static metadata (label,
// description, pip deps, model list) lives in the in-code registry at
// `services/packs/registry.ts`, not the DB. Migration `applyPacksMigration`
// (CREATE TABLE IF NOT EXISTS) keeps existing DBs safe — no data loss.
//
// Schema v35 adds the ACE-Step music generation tables: `ace_songs` (song
// library), `ace_generation_jobs` (async job tracking against the ACE-Step
// FastAPI task id), `ace_playlists` + `ace_playlist_songs` (local playlists).
// Ported from ace-step-ui's `server/src/db/migrate.ts` as SINGLE-USER: no
// `user_id` scoping and no social layer (comments/follows/likes/public-private
// visibility) — see the header comment in
// `migrations/0005_ace_music.ts` for the full rationale. Migration
// `applyAceMusicMigration` (CREATE TABLE IF NOT EXISTS) keeps existing DBs
// safe — no data loss.
//
// Schema v36 adds the ACE-Step training/LoRA/TTS/reference-track tables:
// `ace_training_datasets` (index over dataset JSON files built by the
// training panel), `ace_training_runs` (persisted LoRA training-run
// history — ACE-Step's FastAPI only tracks the current run in memory),
// `ace_stem_jobs` + `ace_tts_jobs` (persisted job status/progress/log,
// replacing ace-step-ui's in-memory `stemJobs.ts` / `ttsJobs.ts` Maps), and
// `ace_reference_tracks` (uploaded reference/source audio with optional
// Whisper-transcribed lyrics, ported from ace-step-ui's Postgres-style
// `reference_tracks` — SINGLE-USER here, so `user_id` scoping is dropped).
// See the header comment in `migrations/0006_ace_training.ts` for the full
// rationale. Migration `applyAceTrainingMigration` (CREATE TABLE IF NOT
// EXISTS) keeps existing DBs safe — no data loss.
//
// Schema v37 adds `ai_toolkit_jobs` — the image-LoRA training job table for
// the AI-Toolkit (ostris/ai-toolkit) capability pack: one row per training
// run (name, base model, dataset path, full training config, status,
// progress, output path, error, timestamps). SINGLE-USER: no `user_id`
// column, same rationale as the ACE-Step training tables above. See the
// header comment in `migrations/0007_ai_toolkit.ts` for the full rationale.
// Migration `applyAiToolkitMigration` (CREATE TABLE IF NOT EXISTS) keeps
// existing DBs safe — no data loss.
//
// Schema v38 adds `pack_models` + `pack_settings` — per-install deviations
// from `services/packs/registry.ts`'s static model catalog (which model ids
// are selected, any repo_override, and download lifecycle state: absent ->
// downloading -> downloaded|failed), plus a generic per-pack settings k/v
// table. A model/pack with no row simply falls back to the registry's
// declared default — these tables never duplicate the registry's data, only
// override it. Companion to the new `services/packs/modelPaths.ts`
// destination resolver, which moved pack model downloads out of
// `~/.local/share/comfy-packs` (invisible to comfy's own model catalog) into
// comfy's managed `models/` tree. See the header comment in
// `migrations/0008_pack_models.ts` for the full rationale. Migration
// `applyPackModelsMigration` (CREATE TABLE IF NOT EXISTS) keeps existing DBs
// safe — no data loss.
//
// Schema v39 turns `ace_songs` into a metadata sidecar of `gallery` instead
// of a parallel silo: generated song audio now lands in
// `paths.comfyOutputDir/ace-step/` (covered by the gallery's disk-sweep and
// normal output backups) and gets a `gallery` row inserted in the same
// transaction as its `ace_songs` row. `ace_songs.gallery_id` FKs to
// `gallery(id) ON DELETE CASCADE`; `audio_url`, `duration`, and `favorite`
// are dropped from `ace_songs` since the gallery now owns them exclusively
// (`favorite` previously existed on both tables and could disagree — only
// `gallery.favorite` survives). No songs had ever been generated when this
// landed, so it's a clean reshape with no backfill; see the header comment
// in `migrations/0009_ace_songs_gallery.ts` for the full rationale and the
// safety check that refuses to drop data if the table isn't actually empty.
export const SCHEMA_VERSION = 39;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS _meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery (
  id             TEXT PRIMARY KEY,
  filename       TEXT NOT NULL,
  subfolder      TEXT NOT NULL DEFAULT '',
  mediaType      TEXT NOT NULL,
  createdAt      INTEGER NOT NULL,
  templateName   TEXT,
  promptId       TEXT,
  sizeBytes      INTEGER,
  url            TEXT,
  type           TEXT NOT NULL DEFAULT 'output',
  workflowJson   TEXT,
  workflowHash   TEXT,
  modelsJson     TEXT,
  jobDurationMs  INTEGER,
  mediaDurationMs INTEGER,
  mediaInfoJson  TEXT,
  favorite       INTEGER NOT NULL DEFAULT 0,
  enhancedPromptsJson TEXT
);
CREATE INDEX IF NOT EXISTS idx_gallery_createdAt ON gallery(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_mediaType ON gallery(mediaType);
CREATE INDEX IF NOT EXISTS idx_gallery_template  ON gallery(templateName);
CREATE INDEX IF NOT EXISTS idx_gallery_prompt    ON gallery(promptId);
-- workflowHash, jobDurationMs, mediaDurationMs, and favorite indexes are created
-- in connection.ts migrations: on legacy DBs these columns do not exist until
-- the migration adds them, so indexing them here would fail on first open.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_unique_promptid_path
  ON gallery(promptId, subfolder, filename)
  WHERE promptId IS NOT NULL AND promptId != '';

CREATE TABLE IF NOT EXISTS plugins_catalog (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  author       TEXT,
  description  TEXT,
  reference    TEXT NOT NULL,
  install_type TEXT,
  trust_level  TEXT,
  raw_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugins_title  ON plugins_catalog(title);
CREATE INDEX IF NOT EXISTS idx_plugins_author ON plugins_catalog(author);

-- Templates table. Canonical shape after v24 -- the source (text) and
-- workflow_json columns are gone (v24 DROP); slim metadata + provenance
-- columns are first-class. Migration paths in connection.ts bring older
-- DBs to this shape; fresh DBs get the right shape directly here.
CREATE TABLE IF NOT EXISTS templates (
  name           TEXT PRIMARY KEY,
  displayName    TEXT NOT NULL,
  category       TEXT,
  description    TEXT,
  tags_json      TEXT,
  installed      INTEGER NOT NULL DEFAULT 0,
  favorite       INTEGER NOT NULL DEFAULT 0,
  updatedAt      INTEGER NOT NULL,
  -- v23
  source_type    INTEGER NOT NULL DEFAULT 0,
  soft_deleted   INTEGER NOT NULL DEFAULT 0,
  -- v24
  thumbnail_json TEXT,
  media_type     TEXT,
  open_source    INTEGER NOT NULL DEFAULT 1,
  search_rank    INTEGER NOT NULL DEFAULT 0,
  username       TEXT,
  -- v33
  template_presets TEXT
);
CREATE INDEX IF NOT EXISTS idx_templates_installed ON templates(installed);
CREATE INDEX IF NOT EXISTS idx_templates_category  ON templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_softdel   ON templates(soft_deleted);
CREATE INDEX IF NOT EXISTS idx_templates_sort      ON templates(search_rank DESC, displayName);
CREATE INDEX IF NOT EXISTS idx_templates_filter    ON templates(soft_deleted, category, source_type);
-- idx_templates_favorite is created in connection.ts alongside the v19 ALTER
-- TABLE: on an existing DB the favorite column does not exist until the
-- migration adds it, so indexing it here would fail before the migration runs.

CREATE TABLE IF NOT EXISTS template_models (
  template       TEXT NOT NULL,
  model_filename TEXT NOT NULL,
  PRIMARY KEY (template, model_filename),
  FOREIGN KEY (template) REFERENCES templates(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_template_models_filename ON template_models(model_filename);

CREATE TABLE IF NOT EXISTS template_plugins (
  template  TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  PRIMARY KEY (template, plugin_id),
  FOREIGN KEY (template) REFERENCES templates(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_template_plugins_id ON template_plugins(plugin_id);

CREATE TABLE IF NOT EXISTS model_files (
  abs_path     TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  root_kind    TEXT NOT NULL CHECK (root_kind IN ('local', 'hub')),
  top_dir      TEXT NOT NULL,
  size         INTEGER NOT NULL,
  status       TEXT NOT NULL,
  scanned_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_model_files_filename ON model_files(filename);
CREATE INDEX IF NOT EXISTS idx_model_files_topdir_filename ON model_files(top_dir, filename);

CREATE TABLE IF NOT EXISTS conversations (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  model            TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  context_strategy TEXT NOT NULL DEFAULT 'sliding',
  num_ctx          INTEGER,
  think_mode       TEXT,
  temperature      REAL,
  format           TEXT,
  soul_name        TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,
  parts               TEXT NOT NULL,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  ms_to_first_token   INTEGER,
  ms_total            INTEGER,
  tokens_per_sec      REAL,
  model               TEXT,
  created_at          INTEGER NOT NULL,
  load_duration_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  display_name    TEXT,
  mime_type       TEXT NOT NULL,
  ext             TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_msg  ON chat_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_attachments_conv ON chat_attachments(conversation_id);

CREATE TABLE IF NOT EXISTS ollama_library (
  name            TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  pulls           TEXT NOT NULL,
  tag_count       TEXT NOT NULL,
  updated         TEXT NOT NULL,
  sizes           TEXT NOT NULL,
  capabilities    TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL,
  updated_ago_sec INTEGER NOT NULL DEFAULT 9999999999
);
CREATE INDEX IF NOT EXISTS idx_ollama_library_title ON ollama_library(title);
CREATE INDEX IF NOT EXISTS idx_ollama_library_updated_ago ON ollama_library(updated_ago_sec);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL UNIQUE,
  hash         TEXT NOT NULL,
  name         TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix     ON api_keys(prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_created_at ON api_keys(created_at DESC);

CREATE TABLE IF NOT EXISTS prompt_snapshots (
  promptId        TEXT PRIMARY KEY,
  apiPromptJson   TEXT NOT NULL,
  templateName    TEXT,
  triggered_by    TEXT,
  conversation_id TEXT,
  message_id      TEXT,
  createdAt       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_createdAt ON prompt_snapshots(createdAt);
`;
