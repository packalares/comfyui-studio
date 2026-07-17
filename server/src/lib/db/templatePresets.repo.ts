// Repository for the `template_presets` TEXT column on `templates`.
//
// The column carries a JSON array of "display cards" for templates whose
// import payload included a `template_presets[]` block (Easy-mode Image /
// Video / Audio builders). Each card holds the minimum the right-panel
// grid needs: id, title, description, local previewUrl, published, tool.
// Per-preset settings blocks live on disk at
// `<userTemplatesDir>/<parent>/<id>.json`; this column is intentionally
// thin so the bundle response can ship the whole list whole.
//
// Kept in its own file (not added to `templates.repo.ts`) so the parent
// repo stays under the 250-line cap and presets stay easy to spot.

import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export interface PresetCard {
  /** 10-char base62 id (matches the existing user-template id shape). */
  id: string;
  title: string;
  description?: string | null;
  /** Local-rewritten thumbnail URL — `/api/thumbnail/preset/<parent>/<filename>`. */
  previewUrl?: string | null;
  /** Mirrors Pikaso's source-side `published` flag; defaults to true. */
  published?: boolean;
  /** Mirrors Pikaso's source-side `tool` field (e.g. `image-generator`). */
  tool?: string | null;
}

/** Parse the JSON column. Returns [] on null / parse error so call sites can
 *  iterate safely without per-call try/catch. */
function parsePresetsColumn(raw: unknown): PresetCard[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is PresetCard =>
      typeof p === 'object' && p !== null
      && typeof (p as { id?: unknown }).id === 'string'
      && typeof (p as { title?: unknown }).title === 'string');
  } catch {
    return [];
  }
}

/** Read the preset cards for a template, or [] when the column is empty. */
export function getPresets(
  name: string,
  db: Database.Database = getDb(),
): PresetCard[] {
  const row = db.prepare('SELECT template_presets FROM templates WHERE name = ?')
    .get(name) as { template_presets: string | null } | undefined;
  if (!row) return [];
  return parsePresetsColumn(row.template_presets);
}

/** Replace the preset cards for a template. Pass `null` (or empty array) to
 *  clear. Always bumps `updatedAt` so cache layers can invalidate. */
export function setPresets(
  name: string,
  presets: PresetCard[] | null,
  db: Database.Database = getDb(),
): void {
  const json = presets && presets.length > 0 ? JSON.stringify(presets) : null;
  db.prepare('UPDATE templates SET template_presets = ?, updatedAt = ? WHERE name = ?')
    .run(json, Date.now(), name);
}

/** Drop the preset cards for a template — used by the cascade-delete path
 *  when a parent is hard-removed and we want the column cleared even if the
 *  row survives (soft-delete case). */
export function clearPresets(
  name: string,
  db: Database.Database = getDb(),
): void {
  setPresets(name, null, db);
}
