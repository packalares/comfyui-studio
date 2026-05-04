// Persisted Ollama library catalog. Replaces the previous module-level
// in-memory cache with a sqlite-backed table so the scrape result survives
// process restarts and the UI can paginate / search server-side without
// shipping the entire list to the browser.
//
// Rows are keyed by `name` (the model identifier, e.g. `llama3.1`). The
// `replaceAll` operation runs in a single transaction — `DELETE *` then
// re-`INSERT` every scraped row — so the table is never observed in a
// half-empty state during a refresh.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export interface OllamaLibraryRow {
  name: string;
  title: string;
  description: string;
  pulls: string;
  tag_count: string;
  updated: string;
  sizes: string[];
  capabilities: string[];
  fetched_at: number;
  /** Approximate seconds-ago derived from the `updated` field at scrape
   *  time. Smaller = newer; sentinel value (9_999_999_999) for unparseable
   *  strings so they sink to the bottom of "newest first" listings. */
  updated_ago_sec: number;
}

function rowFromRecord(row: Record<string, unknown>): OllamaLibraryRow {
  return {
    name: String(row.name),
    title: String(row.title),
    description: String(row.description),
    pulls: String(row.pulls),
    tag_count: String(row.tag_count),
    updated: String(row.updated),
    sizes: parseJsonArray(row.sizes),
    capabilities: parseJsonArray(row.capabilities),
    fetched_at: Number(row.fetched_at ?? 0),
    updated_ago_sec: Number(row.updated_ago_sec ?? 9_999_999_999),
  };
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function count(db: Database.Database = getDb()): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM ollama_library').get() as { c: number }).c;
}

export function lastFetchedAt(db: Database.Database = getDb()): number {
  const r = db.prepare('SELECT MAX(fetched_at) AS m FROM ollama_library').get() as { m: number | null };
  return r.m ?? 0;
}

export interface ListOpts {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListResult {
  items: OllamaLibraryRow[];
  total: number;
}

/**
 * Paginated list with optional case-insensitive substring filter across the
 * three text columns most relevant to a search box (`name`, `title`,
 * `description`). LIKE on a ~150-row table is plenty fast — we don't bring
 * in FTS5 unless the catalog ever grows by an order of magnitude.
 */
export function list(opts: ListOpts = {}, db: Database.Database = getDb()): ListResult {
  const q = (opts.q ?? '').trim();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);

  if (q.length === 0) {
    const total = count(db);
    const rows = db.prepare(
      'SELECT * FROM ollama_library ORDER BY updated_ago_sec ASC, name ASC LIMIT ? OFFSET ?',
    ).all(limit, offset) as Record<string, unknown>[];
    return { items: rows.map(rowFromRecord), total };
  }

  const like = `%${q.toLowerCase()}%`;
  const total = (db.prepare(`
    SELECT COUNT(*) AS c FROM ollama_library
    WHERE LOWER(name) LIKE @like
       OR LOWER(title) LIKE @like
       OR LOWER(description) LIKE @like
  `).get({ like }) as { c: number }).c;
  const rows = db.prepare(`
    SELECT * FROM ollama_library
    WHERE LOWER(name) LIKE @like
       OR LOWER(title) LIKE @like
       OR LOWER(description) LIKE @like
    ORDER BY updated_ago_sec ASC, name ASC
    LIMIT @limit OFFSET @offset
  `).all({ like, limit, offset }) as Record<string, unknown>[];
  return { items: rows.map(rowFromRecord), total };
}

/**
 * Atomic full-replace: clear the table and insert every scraped row inside
 * one transaction. If the scraper returned an empty list the caller is
 * expected NOT to call this (we never want to wipe the table just because
 * the upstream HTML failed to parse — that decision lives in the service).
 */
export function replaceAll(rows: OllamaLibraryRow[], db: Database.Database = getDb()): void {
  const insert = db.prepare(`
    INSERT INTO ollama_library
      (name, title, description, pulls, tag_count, updated, sizes, capabilities, fetched_at, updated_ago_sec)
    VALUES
      (@name, @title, @description, @pulls, @tag_count, @updated, @sizes, @capabilities, @fetched_at, @updated_ago_sec)
  `);
  const tx = db.transaction((items: OllamaLibraryRow[]) => {
    db.prepare('DELETE FROM ollama_library').run();
    for (const r of items) {
      insert.run({
        name: r.name,
        title: r.title,
        description: r.description,
        pulls: r.pulls,
        tag_count: r.tag_count,
        updated: r.updated,
        sizes: JSON.stringify(r.sizes ?? []),
        capabilities: JSON.stringify(r.capabilities ?? []),
        fetched_at: r.fetched_at,
        updated_ago_sec: r.updated_ago_sec,
      });
    }
  });
  tx(rows);
}
