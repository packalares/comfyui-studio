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
// Indexes are deliberately scoped to the columns we sort or filter on in
// routes (`createdAt`, `mediaType`, `templateName`, `promptId`, `title`,
// `author`, `installed`, `category`, `model_filename`, `plugin_id`). Anything
// else stays unindexed or lives inside `raw_json` / `workflow_json`.

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS _meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gallery (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  subfolder   TEXT NOT NULL DEFAULT '',
  mediaType   TEXT NOT NULL,
  createdAt   INTEGER NOT NULL,
  templateName TEXT,
  promptId    TEXT,
  sizeBytes   INTEGER,
  url         TEXT,
  type        TEXT NOT NULL DEFAULT 'output',
  workflowJson TEXT,
  promptText   TEXT,
  negativeText TEXT,
  seed         INTEGER,
  model        TEXT,
  sampler      TEXT,
  steps        INTEGER,
  cfg          REAL,
  width        INTEGER,
  height       INTEGER,
  workflowHash TEXT
);
CREATE INDEX IF NOT EXISTS idx_gallery_createdAt ON gallery(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_mediaType ON gallery(mediaType);
CREATE INDEX IF NOT EXISTS idx_gallery_template  ON gallery(templateName);
CREATE INDEX IF NOT EXISTS idx_gallery_prompt    ON gallery(promptId);
CREATE INDEX IF NOT EXISTS idx_gallery_workflowHash ON gallery(workflowHash);

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
  updatedAt     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_installed ON templates(installed);
CREATE INDEX IF NOT EXISTS idx_templates_category  ON templates(category);

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
`;
