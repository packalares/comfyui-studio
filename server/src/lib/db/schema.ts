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

export const SCHEMA_VERSION = 22;

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
  favorite       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gallery_createdAt ON gallery(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_mediaType ON gallery(mediaType);
CREATE INDEX IF NOT EXISTS idx_gallery_template  ON gallery(templateName);
CREATE INDEX IF NOT EXISTS idx_gallery_prompt    ON gallery(promptId);
CREATE INDEX IF NOT EXISTS idx_gallery_workflowHash ON gallery(workflowHash);
CREATE INDEX IF NOT EXISTS idx_gallery_jobDurationMs ON gallery(jobDurationMs);
CREATE INDEX IF NOT EXISTS idx_gallery_mediaDurationMs ON gallery(mediaDurationMs);
-- idx_gallery_favorite is created in connection.ts alongside the v22 ALTER
-- TABLE: on an existing DB the favorite column does not exist until the
-- migration adds it, so indexing it here would fail before the migration runs.
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

CREATE TABLE IF NOT EXISTS templates (
  name          TEXT PRIMARY KEY,
  displayName   TEXT NOT NULL,
  category      TEXT,
  description   TEXT,
  source        TEXT,
  workflow_json TEXT,
  tags_json     TEXT,
  installed     INTEGER NOT NULL DEFAULT 0,
  favorite      INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_installed ON templates(installed);
CREATE INDEX IF NOT EXISTS idx_templates_category  ON templates(category);
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
