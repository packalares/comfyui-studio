// Characters repository — CRUD for Videoboard characters (PuLID / LoRA).

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';
import type { Character } from '../../contracts/videoboard.js';

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

function rowToCharacter(row: Record<string, unknown>): Character {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as Character['kind'],
    baseModel: row.base_model as Character['baseModel'],
    refPhotoUrls: parseJson<string[]>(row.ref_photos_json) ?? [],
    pulidEmbedPath: row.pulid_embed_path != null ? String(row.pulid_embed_path) : undefined,
    loraPath: row.lora_path != null ? String(row.lora_path) : undefined,
    createdAt: Number(row.created_at ?? 0),
  };
}

export function listCharacters(db: Database.Database = getDb()): Character[] {
  const rows = db.prepare(
    'SELECT * FROM videoboard_characters ORDER BY created_at DESC',
  ).all() as Record<string, unknown>[];
  return rows.map(rowToCharacter);
}

export function getCharacter(
  id: string,
  db: Database.Database = getDb(),
): Character | null {
  const row = db.prepare('SELECT * FROM videoboard_characters WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToCharacter(row) : null;
}

export function createCharacter(
  char: Omit<Character, 'createdAt'> & { createdAt?: number },
  db: Database.Database = getDb(),
): Character {
  const now = char.createdAt ?? Date.now();
  db.prepare(`
    INSERT INTO videoboard_characters
      (id, name, kind, base_model, ref_photos_json, pulid_embed_path, lora_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    char.id,
    char.name,
    char.kind,
    char.baseModel,
    JSON.stringify(char.refPhotoUrls),
    char.pulidEmbedPath ?? null,
    char.loraPath ?? null,
    now,
  );
  return getCharacter(char.id, db)!;
}

export function updateCharacter(
  id: string,
  patch: Partial<Omit<Character, 'id' | 'createdAt'>>,
  db: Database.Database = getDb(),
): Character | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.kind !== undefined) { sets.push('kind = ?'); params.push(patch.kind); }
  if (patch.baseModel !== undefined) { sets.push('base_model = ?'); params.push(patch.baseModel); }
  if (patch.refPhotoUrls !== undefined) { sets.push('ref_photos_json = ?'); params.push(JSON.stringify(patch.refPhotoUrls)); }
  if (patch.pulidEmbedPath !== undefined) { sets.push('pulid_embed_path = ?'); params.push(patch.pulidEmbedPath ?? null); }
  if (patch.loraPath !== undefined) { sets.push('lora_path = ?'); params.push(patch.loraPath ?? null); }
  if (sets.length === 0) return getCharacter(id, db);
  params.push(id);
  db.prepare(`UPDATE videoboard_characters SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getCharacter(id, db);
}

export function deleteCharacter(
  id: string,
  db: Database.Database = getDb(),
): boolean {
  const r = db.prepare('DELETE FROM videoboard_characters WHERE id = ?').run(id);
  return r.changes > 0;
}
