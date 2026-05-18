// Gallery repository. Rows use UUID ids (live pipeline) or `disk-<uuid>`
// (disk-sweep). Every query is a prepared statement with positional params —
// never string-concatenate values into SQL here.

import type Database from 'better-sqlite3';
import type {
  GalleryItem,
  GalleryListItem,
  GalleryRowFull,
} from '../../contracts/generation.contract.js';
import { getDb } from './connection.js';

export interface GalleryRow extends GalleryRowFull {
  createdAt: number;
  templateName?: string | null;
  sizeBytes?: number | null;
  triggeredBy?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  modelFingerprint?: string | null;
  templateHash?: string | null;
  // `models` is the array form passed in at insert time; serialised into
  // `modelsJson` via serializeModels() before INSERT.
  models?: string[] | null;
  // v21 inspection fields: populated from sharp (images) or ffprobe (av).
  jobDurationMs?: number | null;
  mediaDurationMs?: number | null;
  mediaInfoJson?: string | null;
  // v22 user-state field: whether the user has starred this item.
  favorite?: boolean;
}

/** Repo-side slim row: list shape + guaranteed `createdAt`. */
export interface GalleryListRow extends GalleryListItem {
  createdAt: number;
}

export interface GalleryListFilter {
  mediaType?: string;           // 'all' or '' = no filter
  sort?: 'newest' | 'oldest';   // default newest
  favorite?: boolean;           // when true, include only favorited rows
}

export interface GalleryNeighborFilter {
  mediaType?: string;   // '' or 'all' = no filter
  sort?: 'newest' | 'oldest';
  favorite?: boolean;   // when true, restrict neighbors to favorited rows
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
    // Surfaced on slim rows so the tile grid can render a duration pill on
    // audio/video tiles without a per-tile /api/gallery/:id round-trip.
    jobDurationMs: nullableNumber(r.jobDurationMs),
    // v22: user-pinned flag; Boolean() converts 0/1 integer to false/true.
    favorite: Boolean(r.favorite),
  };
}

function parseMediaInfo(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch { return null; }
}

/**
 * Repo result for `/api/gallery/:id` and `/regenerate`. Includes the raw
 * `workflowJson` + `workflowHash` storage fields so routes can either parse
 * them for `workflowDetail` (detail endpoint) or re-submit them
 * (regenerate). Routes strip these before `res.json`.
 */
function rowToFull(r: Record<string, unknown>): GalleryRowFull {
  return {
    ...rowToSlim(r),
    mediaDurationMs: nullableNumber(r.mediaDurationMs),
    mediaInfo: parseMediaInfo(r.mediaInfoJson),
    workflowJson: nullableString(r.workflowJson),
    workflowHash: nullableString(r.workflowHash),
  };
}

/** Columns selected for slim list queries — never includes the fat fields. */
const LIST_COLUMNS =
  'id, filename, subfolder, type, mediaType, url, promptId, ' +
  'templateName, sizeBytes, createdAt, jobDurationMs, favorite';

function serializeModels(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  return JSON.stringify(v.filter((s): s is string => typeof s === 'string'));
}

const GALLERY_COLUMNS =
  'id, filename, subfolder, mediaType, createdAt, templateName, ' +
  'promptId, sizeBytes, url, type, workflowJson, workflowHash, modelsJson, ' +
  'jobDurationMs, mediaDurationMs, mediaInfoJson, ' +
  'triggered_by, conversation_id, message_id, model_fingerprint, template_hash, ' +
  'favorite';

const GALLERY_VALUES_PLACEHOLDERS = new Array(22).fill('?').join(', ');

function rowParams(item: GalleryRow): unknown[] {
  return [
    item.id, item.filename, item.subfolder ?? '', item.mediaType,
    item.createdAt, item.templateName ?? null, item.promptId ?? null,
    item.sizeBytes ?? null, item.url ?? '', item.type ?? 'output',
    item.workflowJson ?? null, item.workflowHash ?? null,
    serializeModels(item.models),
    item.jobDurationMs ?? null, item.mediaDurationMs ?? null, item.mediaInfoJson ?? null,
    item.triggeredBy ?? null, item.conversationId ?? null, item.messageId ?? null,
    item.modelFingerprint ?? null, item.templateHash ?? null,
    // favorite is user state — new rows default to 0 (unfavorited).
    (item.favorite ? 1 : 0),
  ];
}

export function insert(item: GalleryRow, db: Database.Database = getDb()): void {
  db.prepare(
    `INSERT OR REPLACE INTO gallery (${GALLERY_COLUMNS}) VALUES (${GALLERY_VALUES_PLACEHOLDERS})`,
  ).run(...rowParams(item));
}

/**
 * History-agnostic insert: upsert a gallery row with COALESCE-upgrade so
 * that null metadata columns filled by a later event backfill a row already
 * written by an earlier one. Returns true when changes were made (new row
 * or metadata upgraded).
 */
export function insertGalleryRow(
  item: GalleryRow, db: Database.Database = getDb(),
): boolean {
  const coalesceCols = [
    'workflowJson', 'workflowHash', 'modelsJson', 'templateName', 'sizeBytes',
    'jobDurationMs', 'mediaDurationMs', 'mediaInfoJson',
    'triggered_by', 'conversation_id', 'message_id',
    'model_fingerprint', 'template_hash',
  ];
  const updateSet = coalesceCols
    .map(c => `${c} = COALESCE(gallery.${c}, excluded.${c})`)
    .join(', ');
  const info = db.prepare(
    `INSERT INTO gallery (${GALLERY_COLUMNS}) VALUES (${GALLERY_VALUES_PLACEHOLDERS}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updateSet}`,
  ).run(...rowParams(item));
  return info.changes > 0;
}

/** Cache-hit lookup: find rows with this workflowHash, newest first. */
export function findByWorkflowHash(
  hash: string,
  limit = 5,
  db: Database.Database = getDb(),
): GalleryRowFull[] {
  if (!hash) return [];
  const rows = db.prepare(
    'SELECT * FROM gallery WHERE workflowHash = ? ORDER BY createdAt DESC LIMIT ?',
  ).all(hash, Math.max(1, Math.floor(limit))) as Record<string, unknown>[];
  return rows.map(rowToFull);
}

export function remove(id: string, db: Database.Database = getDb()): boolean {
  const r = db.prepare('DELETE FROM gallery WHERE id = ?').run(id);
  return r.changes > 0;
}

export function getById(id: string, db: Database.Database = getDb()): GalleryRowFull | null {
  const r = db.prepare('SELECT * FROM gallery WHERE id = ?').get(id) as
    | Record<string, unknown> | undefined;
  return r ? rowToFull(r) : null;
}

/** Alias kept for callers; identical to `getById`. */
export function getByIdFull(id: string, db: Database.Database = getDb()): GalleryRowFull | null {
  return getById(id, db);
}

export function count(db: Database.Database = getDb()): number {
  const r = db.prepare('SELECT COUNT(*) as c FROM gallery').get() as { c: number };
  return r.c;
}

/** Slim list — no workflowJson or KSampler metadata. */
export function listAll(
  filter: GalleryListFilter = {},
  db: Database.Database = getDb(),
): GalleryListRow[] {
  const { mediaType, sort, favorite } = filter;
  const dir = sort === 'oldest' ? 'ASC' : 'DESC';
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (mediaType && mediaType !== 'all') { conditions.push('mediaType = ?'); params.push(mediaType); }
  if (favorite === true) conditions.push('favorite = 1');
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT ${LIST_COLUMNS} FROM gallery ${where} ORDER BY createdAt ${dir}, id ${dir}`;
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSlim);
}

/** Look up gallery rows whose `promptId` is in the provided set. */
export function listByPromptIds(
  promptIds: readonly string[],
  db: Database.Database = getDb(),
): GalleryListRow[] {
  const ids = promptIds.filter(id => typeof id === 'string' && id.length > 0);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT ${LIST_COLUMNS} FROM gallery WHERE promptId IN (${placeholders}) ORDER BY createdAt DESC`;
  const rows = db.prepare(sql).all(...ids) as Record<string, unknown>[];
  return rows.map(rowToSlim);
}

export interface PageResult {
  items: GalleryListRow[];
  total: number;
}

/**
 * Find the IDs of the rows displayed immediately before and after `id`
 * within the current filter+sort. "Before" and "after" are visual — for
 * newest-first (default), prev = next-newer row, next = next-older row.
 * (createdAt, id) is the stable tie-breaker so duplicate timestamps don't
 * oscillate.
 */
export function findNeighborIds(
  id: string,
  filter: GalleryNeighborFilter = {},
  db: Database.Database = getDb(),
): { prevId: string | null; nextId: string | null } {
  const anchor = db.prepare('SELECT createdAt FROM gallery WHERE id = ?').get(id) as
    | { createdAt: number } | undefined;
  if (!anchor) return { prevId: null, nextId: null };
  const ts = anchor.createdAt;

  const useMediaFilter = !!(filter.mediaType && filter.mediaType !== 'all');
  const mf = filter.mediaType ?? '';
  const oldest = filter.sort === 'oldest';
  const useFavFilter = filter.favorite === true;

  // Build the WHERE fragments for media + favorite filters.
  const baseParts: string[] = [];
  if (useMediaFilter) baseParts.push('mediaType = ?');
  if (useFavFilter) baseParts.push('favorite = 1');
  const baseWhere = baseParts.length > 0 ? baseParts.join(' AND ') + ' AND ' : '';
  const baseParams: unknown[] = [];
  if (useMediaFilter) baseParams.push(mf);
  // (favorite = 1 has no param — literal)

  // For newest-first (default):
  //   next = older = smaller createdAt
  //   prev = newer = larger createdAt
  // For oldest-first: swap the two.
  let nextSql: string;
  let prevSql: string;

  if (!oldest) {
    // newest-first display
    nextSql = `SELECT id FROM gallery WHERE ${baseWhere}(createdAt < ? OR (createdAt = ? AND id < ?)) ORDER BY createdAt DESC, id DESC LIMIT 1`;
    prevSql = `SELECT id FROM gallery WHERE ${baseWhere}(createdAt > ? OR (createdAt = ? AND id > ?)) ORDER BY createdAt ASC, id ASC LIMIT 1`;
  } else {
    // oldest-first display (visual directions flip)
    nextSql = `SELECT id FROM gallery WHERE ${baseWhere}(createdAt > ? OR (createdAt = ? AND id > ?)) ORDER BY createdAt ASC, id ASC LIMIT 1`;
    prevSql = `SELECT id FROM gallery WHERE ${baseWhere}(createdAt < ? OR (createdAt = ? AND id < ?)) ORDER BY createdAt DESC, id DESC LIMIT 1`;
  }

  const nextParams = [...baseParams, ts, ts, id];
  const prevParams = [...baseParams, ts, ts, id];

  const nextRow = db.prepare(nextSql).get(...nextParams) as { id: string } | undefined;
  const prevRow = db.prepare(prevSql).get(...prevParams) as { id: string } | undefined;

  return {
    prevId: prevRow?.id ?? null,
    nextId: nextRow?.id ?? null,
  };
}

/**
 * Pin / unpin a gallery item (the "favorite" star). Returns `false` when no
 * row matched — callers surface that as a 404. `insertGalleryRow`'s COALESCE
 * upgrade never touches `favorite`, so a metadata backfill preserves the
 * user's pin — only this function writes it.
 */
export function setFavorite(
  id: string,
  favorite: boolean,
  db: Database.Database = getDb(),
): boolean {
  const info = db
    .prepare('UPDATE gallery SET favorite = ? WHERE id = ?')
    .run(favorite ? 1 : 0, id);
  return info.changes > 0;
}

export function listPaginated(
  filter: GalleryListFilter,
  page: number,
  pageSize: number,
  db: Database.Database = getDb(),
): PageResult {
  const { mediaType, sort, favorite } = filter;
  const dir = sort === 'oldest' ? 'ASC' : 'DESC';
  const conditions: string[] = [];
  const baseParams: unknown[] = [];
  if (mediaType && mediaType !== 'all') { conditions.push('mediaType = ?'); baseParams.push(mediaType); }
  if (favorite === true) conditions.push('favorite = 1');
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM gallery ${where}`)
    .get(...baseParams) as { c: number }).c;
  const offset = Math.max(0, (page - 1) * pageSize);
  const sql = `SELECT ${LIST_COLUMNS} FROM gallery ${where} ORDER BY createdAt ${dir}, id ${dir} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...baseParams, pageSize, offset) as Record<string, unknown>[];
  return { items: rows.map(rowToSlim), total };
}

