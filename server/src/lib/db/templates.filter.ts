// SQL WHERE builder for `templates.listPaginated`.
//
// Extracted so the repo stays under the 250-line cap. Keeps every user value
// bound as a parameter — never string-concatenate into the output SQL.

export interface TemplateListFilter {
  q?: string;
  category?: string;
  tags?: string[];
  /**
   * Filter by source bucket. `visible` = open-from-comfy OR any user import
   * (i.e. everything the user can run on local hardware). Used by the route
   * when there's no API key so "All" still spans both ComfyUI-open templates
   * and the user's own imports.
   */
  source?: 'open' | 'api' | 'user' | 'favorites' | 'visible' | 'all';
  ready?: 'yes' | 'no' | 'all';
  /** When true, include soft-deleted rows (default: exclude). */
  softDeleted?: boolean;
}

export interface WhereClause {
  sql: string;                // "" or "WHERE <clauses>"
  params: unknown[];
}

export function buildTemplatesWhere(filter: TemplateListFilter): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

  // Soft-delete exclusion (default behaviour).
  if (!filter.softDeleted) {
    clauses.push('soft_deleted = 0');
  }

  const q = (filter.q ?? '').trim().toLowerCase();
  if (q) {
    // Last clause searches required-model filenames via the `template_models`
    // side table so e.g. `flux` or `wan2.2` surfaces workflows that pull those
    // weights, not just workflows whose name/description mention them.
    clauses.push(
      "(LOWER(name) LIKE ? " +
      "OR LOWER(displayName) LIKE ? " +
      "OR LOWER(COALESCE(description,'')) LIKE ? " +
      "OR LOWER(COALESCE(category,'')) LIKE ? " +
      "OR LOWER(COALESCE(username,'')) LIKE ? " +
      "OR EXISTS (SELECT 1 FROM template_models tm " +
      "WHERE tm.template = templates.name " +
      "AND LOWER(tm.model_filename) LIKE ?))",
    );
    const needle = `%${q}%`;
    params.push(needle, needle, needle, needle, needle, needle);
  }
  if (filter.category && filter.category !== 'All') {
    clauses.push('category = ?');
    params.push(filter.category);
  }
  // Source filter. The `open` / `api` filters are anchored to source_type=1
  // (comfy-catalog) so they don't double-count user imports: a civitai or
  // upload template is `open_source=1` too, but should only appear under
  // "Imported", not under "ComfyUI". Keeping the filters mutually exclusive
  // (open / api / user) means "All" stays consistent with the sum of parts.
  const src = filter.source ?? 'all';
  if (src === 'open') {
    clauses.push('open_source = 1 AND source_type = 1');
  } else if (src === 'api') {
    clauses.push('open_source = 0 AND source_type = 1');
  } else if (src === 'user') {
    // source_type ∈ {2,3,4} = civitai / github / upload.
    clauses.push('source_type IN (2, 3, 4)');
  } else if (src === 'favorites') {
    clauses.push('favorite = 1');
  } else if (src === 'visible') {
    // "Everything I can run locally": open comfy-catalog + any user import.
    // Used by the route when no API key — hides cloud-API comfy templates.
    clauses.push('(source_type IN (2, 3, 4) OR (source_type = 1 AND open_source = 1))');
  }
  if (filter.ready === 'yes') clauses.push('installed = 1');
  else if (filter.ready === 'no') clauses.push('installed = 0');
  if (filter.tags && filter.tags.length > 0) {
    const tagClauses = filter.tags.map(() => "COALESCE(tags_json, '') LIKE ?");
    clauses.push(`(${tagClauses.join(' OR ')})`);
    for (const tag of filter.tags) {
      // Match the tag as it appears inside the JSON-encoded tags string —
      // quoted, with JSON escapes applied, so partial-token collisions
      // between tag values are unlikely.
      params.push(`%${JSON.stringify(tag).slice(1, -1)}%`);
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}
