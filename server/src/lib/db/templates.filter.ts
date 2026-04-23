// SQL WHERE builder for `templates.listPaginated`.
//
// Extracted so the repo stays under the 250-line cap. Keeps every user value
// bound as a parameter — never string-concatenate into the output SQL.

export interface TemplateListFilter {
  q?: string;
  category?: string;
  tags?: string[];
  source?: string;
  ready?: 'yes' | 'no' | 'all';
}

export interface WhereClause {
  sql: string;                // "" or "WHERE <clauses>"
  params: unknown[];
}

export function buildTemplatesWhere(filter: TemplateListFilter): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

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
      "OR LOWER(COALESCE(tags_json,'')) LIKE ? " +
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
  if (filter.source && filter.source !== 'all') {
    clauses.push('source = ?');
    params.push(filter.source);
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
