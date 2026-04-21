// Gallery repository. Backs `GET /gallery` and the generation-complete hook.
//
// Rows are keyed on `<promptId>-<filename>` to match the existing id scheme
// from `getGalleryItems()` — this keeps per-execution appends idempotent
// (the same prompt/file pair processed twice won't duplicate) and lets the
// event-driven path use `INSERT OR IGNORE` so a user-deleted row never
// resurrects from a stale ComfyUI history entry.
//
// Every query is a prepared statement; parameters are positional so the
// driver escapes them — never string-concatenate into SQL here.

import type Database from 'better-sqlite3';
import type {
  GalleryItem,
  GalleryListItem,
} from '../../contracts/generation.contract.js';
import { getDb } from './connection.js';

export interface GalleryRow extends GalleryItem {
  createdAt: number;
  templateName?: string | null;
  sizeBytes?: number | null;
}

/** Repo-side slim row: list shape + guaranteed `createdAt`. */
export interface GalleryListRow extends GalleryListItem {
  createdAt: number;
}

export interface GalleryListFilter {
  mediaType?: string;           // 'all' or '' = no filter
  sort?: 'newest' | 'oldest';   // default newest
}

function nullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

function rowToSlim(r: Record<string, unknown>): GalleryListRow {
  return {
    id: String(r.id),
    filename: String(r.filename),
    subfolder: String(r.subfolder ?? ''),
    type: String(r.type ?? 'output'),
    mediaType: String(r.mediaType),
    url: String(r.url ?? ''),
    promptId: String(r.promptId ?? ''),
    templateName: nullableString(r.templateName),
    sizeBytes: nullableNumber(r.sizeBytes),
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
  };
}

function rowToItem(r: Record<string, unknown>): GalleryItem {
  return {
    ...rowToSlim(r),
    workflowJson: nullableString(r.workflowJson),
    promptText:   nullableString(r.promptText),
    negativeText: nullableString(r.negativeText),
    seed:   nullableNumber(r.seed),
    model:  nullableString(r.model),
    sampler: nullableString(r.sampler),
    steps:  nullableNumber(r.steps),
    cfg:    nullableNumber(r.cfg),
    width:  nullableNumber(r.width),
    height: nullableNumber(r.height),
  };
}

/** Columns selected for slim list queries — never includes the fat fields. */
const LIST_COLUMNS =
  'id, filename, subfolder, type, mediaType, url, promptId, ' +
  'templateName, sizeBytes, createdAt';

export function insert(item: GalleryRow, db: Database.Database = getDb()): void {
  db.prepare(`
    INSERT OR REPLACE INTO gallery
      (id, filename, subfolder, mediaType, createdAt, templateName,
       promptId, sizeBytes, url, type,
       workflowJson, promptText, negativeText, seed, model,
       sampler, steps, cfg, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id, item.filename, item.subfolder ?? '', item.mediaType,
    item.createdAt, item.templateName ?? null, item.promptId ?? null,
    item.sizeBytes ?? null, item.url ?? '', item.type ?? 'output',
    item.workflowJson ?? null, item.promptText ?? null,
    item.negativeText ?? null, item.seed ?? null, item.model ?? null,
    item.sampler ?? null, item.steps ?? null, item.cfg ?? null,
    item.width ?? null, item.height ?? null,
  );
}

/**
 * Event-driven append: insert ONLY when the row is absent. Used by the WS
 * `execution_complete` path so a user-deleted row never resurrects from a
 * stale ComfyUI history entry — the opposite semantics from `insert()`
 * which uses OR REPLACE. Returns true when a row was written, false when
 * the id already existed (already present or previously tombstoned).
 */
export function appendFromHistory(
  item: GalleryRow, db: Database.Database = getDb(),
): boolean {
  // Insert new row OR upgrade an existing one with metadata. The `executed`
  // event path inserts rows with just the file shape (workflowJson/prompt
  // text/seed/... are null). When `execution_success` later fires with
  // full history data, we DO NOT want INSERT OR IGNORE to skip the update.
  // Instead: COALESCE against existing values so nulls get filled in and
  // previously-set fields are preserved.
  const info = db.prepare(`
    INSERT INTO gallery
      (id, filename, subfolder, mediaType, createdAt, templateName,
       promptId, sizeBytes, url, type,
       workflowJson, promptText, negativeText, seed, model,
       sampler, steps, cfg, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workflowJson = COALESCE(gallery.workflowJson, excluded.workflowJson),
      promptText   = COALESCE(gallery.promptText,   excluded.promptText),
      negativeText = COALESCE(gallery.negativeText, excluded.negativeText),
      seed         = COALESCE(gallery.seed,         excluded.seed),
      model        = COALESCE(gallery.model,        excluded.model),
      sampler      = COALESCE(gallery.sampler,      excluded.sampler),
      steps        = COALESCE(gallery.steps,        excluded.steps),
      cfg          = COALESCE(gallery.cfg,          excluded.cfg),
      width        = COALESCE(gallery.width,        excluded.width),
      height       = COALESCE(gallery.height,       excluded.height),
      templateName = COALESCE(gallery.templateName, excluded.templateName),
      sizeBytes    = COALESCE(gallery.sizeBytes,    excluded.sizeBytes)
  `).run(
    item.id, item.filename, item.subfolder ?? '', item.mediaType,
    item.createdAt, item.templateName ?? null, item.promptId ?? null,
    item.sizeBytes ?? null, item.url ?? '', item.type ?? 'output',
    item.workflowJson ?? null, item.promptText ?? null,
    item.negativeText ?? null, item.seed ?? null, item.model ?? null,
    item.sampler ?? null, item.steps ?? null, item.cfg ?? null,
    item.width ?? null, item.height ?? null,
  );
  return info.changes > 0;
}

export function remove(id: string, db: Database.Database = getDb()): boolean {
  const r = db.prepare('DELETE FROM gallery WHERE id = ?').run(id);
  return r.changes > 0;
}

export function getById(id: string, db: Database.Database = getDb()): GalleryItem | null {
  const r = db.prepare('SELECT * FROM gallery WHERE id = ?').get(id) as
    | Record<string, unknown> | undefined;
  return r ? rowToItem(r) : null;
}

/**
 * Full-row lookup used by `GET /api/gallery/:id` — returns every captured
 * generation-metadata field (workflowJson, prompt text, KSampler params).
 * Aliased to `getById` but exposed under its own name so call sites that
 * specifically need the fat payload read clearly at the usage point.
 */
export function getByIdFull(id: string, db: Database.Database = getDb()): GalleryItem | null {
  return getById(id, db);
}

export function count(db: Database.Database = getDb()): number {
  const r = db.prepare('SELECT COUNT(*) as c FROM gallery').get() as { c: number };
  return r.c;
}

/**
 * Slim list — returns rows without `workflowJson` + KSampler metadata. Wave
 * P trimmed the list payload after measuring 2-10 KB per row of fat fields
 * the tile grid never renders. `GET /api/gallery/:id` returns the full row.
 */
export function listAll(
  filter: GalleryListFilter = {},
  db: Database.Database = getDb(),
): GalleryListRow[] {
  const { mediaType, sort } = filter;
  const dir = sort === 'oldest' ? 'ASC' : 'DESC';
  const where = mediaType && mediaType !== 'all' ? 'WHERE mediaType = ?' : '';
  const params = mediaType && mediaType !== 'all' ? [mediaType] : [];
  const sql = `SELECT ${LIST_COLUMNS} FROM gallery ${where} ORDER BY createdAt ${dir}, id ${dir}`;
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSlim);
}

export interface PageResult {
  items: GalleryListRow[];
  total: number;
}

export function listPaginated(
  filter: GalleryListFilter,
  page: number,
  pageSize: number,
  db: Database.Database = getDb(),
): PageResult {
  const { mediaType, sort } = filter;
  const dir = sort === 'oldest' ? 'ASC' : 'DESC';
  const useFilter = !!(mediaType && mediaType !== 'all');
  const where = useFilter ? 'WHERE mediaType = ?' : '';
  const cParams = useFilter ? [mediaType] : [];
  const total = (db.prepare(`SELECT COUNT(*) as c FROM gallery ${where}`)
    .get(...cParams) as { c: number }).c;
  const offset = Math.max(0, (page - 1) * pageSize);
  const sql = `SELECT ${LIST_COLUMNS} FROM gallery ${where} ORDER BY createdAt ${dir}, id ${dir} LIMIT ? OFFSET ?`;
  const params = useFilter ? [mediaType, pageSize, offset] : [pageSize, offset];
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return { items: rows.map(rowToSlim), total };
}

