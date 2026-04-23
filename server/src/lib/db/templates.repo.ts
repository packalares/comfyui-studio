// Templates repository. Persists the template catalog + dep graph so the
// Explore page can filter on "ready / not ready" without reshaping the
// catalog on every request.
//
// Rows are keyed on the template `name` (mirrors ComfyUI's template id). The
// dep graph lives in two child tables (`template_models`, `template_plugins`)
// with ON DELETE CASCADE — wiping a template row wipes its edges.
//
// All writes are prepared statements inside a single WAL transaction. List
// reads build up a parameterised WHERE clause via `templates.filter.ts` and
// never string-concatenate user input.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';
import { buildTemplatesWhere, type TemplateListFilter } from './templates.filter.js';

export type { TemplateListFilter } from './templates.filter.js';

export interface TemplateRow {
  name: string;
  displayName: string;
  category?: string | null;
  description?: string | null;
  source?: string | null;
  workflow_json?: string | null;
  tags_json?: string | null;
  installed?: boolean;
}

export interface TemplateListRow extends TemplateRow {
  updatedAt: number;
  installed: boolean;
  models: string[];
  plugins: string[];
  tags: string[];
}

export interface TemplatePageResult {
  items: TemplateListRow[];
  total: number;
  hasMore: boolean;
}

export interface TemplateDeps {
  models: string[];
  plugins: string[];
}

// ---- Internal helpers ----------------------------------------------------

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch { /* ignore */ }
  return [];
}

function hydrate(
  db: Database.Database,
  row: Record<string, unknown>,
): TemplateListRow {
  const name = String(row.name);
  const models = db.prepare(
    'SELECT model_filename AS fn FROM template_models WHERE template = ? ORDER BY fn',
  ).all(name) as Array<{ fn: string }>;
  const plugins = db.prepare(
    'SELECT plugin_id AS id FROM template_plugins WHERE template = ? ORDER BY id',
  ).all(name) as Array<{ id: string }>;
  return {
    name,
    displayName: String(row.displayName ?? name),
    category: row.category == null ? null : String(row.category),
    description: row.description == null ? null : String(row.description),
    source: row.source == null ? null : String(row.source),
    workflow_json: row.workflow_json == null ? null : String(row.workflow_json),
    tags_json: row.tags_json == null ? null : String(row.tags_json),
    updatedAt: Number(row.updatedAt ?? 0),
    installed: Number(row.installed ?? 0) === 1,
    models: models.map((r) => r.fn),
    plugins: plugins.map((r) => r.id),
    tags: parseJsonArray(row.tags_json),
  };
}

function writeRow(
  db: Database.Database,
  t: TemplateRow,
  deps: TemplateDeps,
): void {
  db.prepare(`
    INSERT INTO templates
      (name, displayName, category, description, source, workflow_json,
       tags_json, installed, updatedAt)
    VALUES (@name, @displayName, @category, @description, @source,
            @workflow_json, @tags_json, @installed, @updatedAt)
    ON CONFLICT(name) DO UPDATE SET
      displayName   = excluded.displayName,
      category      = excluded.category,
      description   = excluded.description,
      source        = excluded.source,
      workflow_json = excluded.workflow_json,
      tags_json     = excluded.tags_json,
      installed     = excluded.installed,
      updatedAt     = excluded.updatedAt
  `).run({
    name: t.name,
    displayName: t.displayName,
    category: t.category ?? null,
    description: t.description ?? null,
    source: t.source ?? null,
    workflow_json: t.workflow_json ?? null,
    tags_json: t.tags_json ?? null,
    installed: t.installed ? 1 : 0,
    updatedAt: Date.now(),
  });
  db.prepare('DELETE FROM template_models WHERE template = ?').run(t.name);
  db.prepare('DELETE FROM template_plugins WHERE template = ?').run(t.name);
  const insModel = db.prepare(
    'INSERT OR IGNORE INTO template_models (template, model_filename) VALUES (?, ?)',
  );
  const insPlugin = db.prepare(
    'INSERT OR IGNORE INTO template_plugins (template, plugin_id) VALUES (?, ?)',
  );
  for (const fn of deps.models) insModel.run(t.name, fn);
  for (const pid of deps.plugins) insPlugin.run(t.name, pid);
}

// ---- Public API ----------------------------------------------------------

export function count(db: Database.Database = getDb()): number {
  return (db.prepare('SELECT COUNT(*) as c FROM templates').get() as { c: number }).c;
}

export function upsertTemplate(
  t: TemplateRow,
  deps: TemplateDeps,
  db: Database.Database = getDb(),
): void {
  const tx = db.transaction(() => writeRow(db, t, deps));
  tx();
}

export function getInstalledFlag(
  name: string,
  db: Database.Database = getDb(),
): boolean {
  const row = db.prepare('SELECT installed FROM templates WHERE name = ?').get(name) as
    | { installed: number } | undefined;
  return row ? row.installed === 1 : false;
}

export function deleteTemplate(
  name: string,
  db: Database.Database = getDb(),
): void {
  db.prepare('DELETE FROM templates WHERE name = ?').run(name);
}

export function setInstalledForTemplates(
  names: string[],
  installed: boolean,
  db: Database.Database = getDb(),
): void {
  if (names.length === 0) return;
  const stmt = db.prepare('UPDATE templates SET installed = ?, updatedAt = ? WHERE name = ?');
  const tx = db.transaction((list: string[]) => {
    const now = Date.now();
    for (const n of list) stmt.run(installed ? 1 : 0, now, n);
  });
  tx(names);
}

export function findTemplatesRequiringModel(
  filename: string,
  db: Database.Database = getDb(),
): string[] {
  const rows = db.prepare(
    'SELECT template FROM template_models WHERE model_filename = ? ORDER BY template',
  ).all(filename) as Array<{ template: string }>;
  return rows.map((r) => r.template);
}

/**
 * Full-text-style lookup: every template whose required-model filename
 * contains `needle` (case-insensitive substring). Used by the /templates
 * search endpoint so typing a model filename surfaces every workflow that
 * pulls it, not just the ones whose title/description happen to mention it.
 */
export function findTemplatesByModelSubstring(
  needle: string,
  db: Database.Database = getDb(),
): string[] {
  const trimmed = needle.trim();
  if (!trimmed) return [];
  const rows = db.prepare(
    'SELECT DISTINCT template FROM template_models WHERE LOWER(model_filename) LIKE ? ORDER BY template',
  ).all(`%${trimmed.toLowerCase()}%`) as Array<{ template: string }>;
  return rows.map((r) => r.template);
}

export function findTemplatesRequiringPlugin(
  pluginId: string,
  db: Database.Database = getDb(),
): string[] {
  const rows = db.prepare(
    'SELECT template FROM template_plugins WHERE plugin_id = ? ORDER BY template',
  ).all(pluginId) as Array<{ template: string }>;
  return rows.map((r) => r.template);
}

export function getTemplate(
  name: string,
  db: Database.Database = getDb(),
): TemplateListRow | null {
  const row = db.prepare('SELECT * FROM templates WHERE name = ?').get(name) as
    | Record<string, unknown> | undefined;
  return row ? hydrate(db, row) : null;
}

export function listAllNames(db: Database.Database = getDb()): string[] {
  return (db.prepare('SELECT name FROM templates').all() as Array<{ name: string }>)
    .map((r) => r.name);
}

export function listPaginated(
  filter: TemplateListFilter,
  page: number,
  pageSize: number,
  db: Database.Database = getDb(),
): TemplatePageResult {
  const where = buildTemplatesWhere(filter);
  const total = (db.prepare(`SELECT COUNT(*) as c FROM templates ${where.sql}`)
    .get(...where.params) as { c: number }).c;
  const offset = Math.max(0, (page - 1) * pageSize);
  const sql = `SELECT * FROM templates ${where.sql} ORDER BY displayName COLLATE NOCASE ASC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...where.params, pageSize, offset) as Record<string, unknown>[];
  const items = rows.map((r) => hydrate(db, r));
  return { items, total, hasMore: offset + items.length < total };
}

export interface RebuildEntry {
  template: TemplateRow;
  deps: TemplateDeps;
}

/**
 * Wipe every stored template + dep edge and re-insert the supplied set in a
 * single transaction. Used by the refresh endpoint to diff-replace when the
 * upstream catalog changes drastically; narrower diff paths use
 * `upsertTemplate` + `deleteTemplate` instead.
 */
export function rebuildAll(
  entries: RebuildEntry[],
  db: Database.Database = getDb(),
): number {
  const tx = db.transaction((list: RebuildEntry[]) => {
    db.prepare('DELETE FROM template_models').run();
    db.prepare('DELETE FROM template_plugins').run();
    db.prepare('DELETE FROM templates').run();
    for (const e of list) writeRow(db, e.template, e.deps);
  });
  tx(entries);
  return entries.length;
}
