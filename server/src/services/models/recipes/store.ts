// SQLite CRUD layer for recipes.
// All methods are synchronous (better-sqlite3 is sync) and pure data —
// no validation logic here; that belongs in the route layer.

import { getDb } from '../../../lib/db/connection.js';
import type { Recipe, NewRecipe } from './types.js';

interface RecipeRow {
  id: number;
  title: string;
  notes: string | null;
  tags_json: string | null;
  loras_json: string;
  created_at: number;
  updated_at: number;
}

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes ?? undefined,
    tags: row.tags_json ? (JSON.parse(row.tags_json) as string[]) : [],
    loras: JSON.parse(row.loras_json) as Recipe['loras'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListFilter {
  search?: string;
  tag?: string;
}

export function list(filter?: ListFilter): Recipe[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM recipes ORDER BY updated_at DESC').all() as RecipeRow[];
  let results = rows.map(rowToRecipe);

  if (filter?.search) {
    const needle = filter.search.toLowerCase();
    results = results.filter((r) => r.title.toLowerCase().includes(needle));
  }
  if (filter?.tag) {
    const tag = filter.tag;
    results = results.filter((r) => r.tags.includes(tag));
  }
  return results;
}

export function get(id: number): Recipe | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as RecipeRow | undefined;
  return row ? rowToRecipe(row) : null;
}

export function create(input: NewRecipe): Recipe {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO recipes (title, notes, tags_json, loras_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.title,
    input.notes ?? null,
    JSON.stringify(input.tags),
    JSON.stringify(input.loras),
    now,
    now,
  );
  return get(result.lastInsertRowid as number)!;
}

export function update(id: number, patch: Partial<NewRecipe>): Recipe | null {
  const db = getDb();
  const existing = get(id);
  if (!existing) return null;

  const merged: NewRecipe = {
    title: patch.title ?? existing.title,
    notes: 'notes' in patch ? patch.notes : existing.notes,
    tags: patch.tags ?? existing.tags,
    loras: patch.loras ?? existing.loras,
  };

  db.prepare(`
    UPDATE recipes
    SET title = ?, notes = ?, tags_json = ?, loras_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    merged.title,
    merged.notes ?? null,
    JSON.stringify(merged.tags),
    JSON.stringify(merged.loras),
    Date.now(),
    id,
  );
  return get(id);
}

export function remove(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
  return result.changes > 0;
}
