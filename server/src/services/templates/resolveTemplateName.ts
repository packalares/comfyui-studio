// Fuzzy template-name resolution, shared by the MCP studio tools that take a
// template `name` (describe / check-dependencies / submit-generation). The LLM
// often passes a guessed display title ("Wan2.1 VACE Inpainting") instead of
// the slug — this resolves an exact slug, a single fuzzy match, or hands back
// a candidate list so the caller can ask the model to pick.

import { getTemplate, getTemplates } from './index.js';

export interface TemplateRef {
  name: string;
  title: string;
}

export type TemplateNameResolution =
  | { name: string }
  | { candidates: TemplateRef[] }
  | null;

function refOf(t: { name: string; title?: string }): TemplateRef {
  return { name: t.name, title: t.title ?? t.name };
}

/**
 * Resolve a possibly-fuzzy template reference. Returns:
 *  - `{ name }`        when an exact slug matches, or there's exactly one fuzzy match
 *  - `{ candidates }`  when several templates plausibly match (ask the model to pick)
 *  - `null`            when nothing is close
 */
export function resolveTemplateName(input: string): TemplateNameResolution {
  if (getTemplate(input)) return { name: input };

  const all = getTemplates();
  const q = input.trim().toLowerCase();

  const ciExact = all.filter(
    (t) => t.name.toLowerCase() === q || (t.title ?? '').toLowerCase() === q,
  );
  if (ciExact.length === 1) return { name: ciExact[0].name };
  if (ciExact.length > 1) return { candidates: ciExact.map(refOf) };

  const subs = all.filter(
    (t) => t.name.toLowerCase().includes(q) || (t.title ?? '').toLowerCase().includes(q),
  );
  if (subs.length === 1) return { name: subs[0].name };
  if (subs.length > 1) return { candidates: subs.slice(0, 8).map(refOf) };

  // Token-overlap fallback: how many of the query's words land in name/title.
  const words = q.split(/[\s_/.-]+/).filter(Boolean);
  if (words.length === 0) return null;
  const scored = all
    .map((t) => {
      const hay = `${t.name} ${t.title ?? ''}`.toLowerCase();
      return { t, hits: words.filter((w) => hay.includes(w)).length };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (scored.length === 0) return null;
  if (scored.length === 1 && scored[0].hits === words.length) return { name: scored[0].t.name };
  return { candidates: scored.slice(0, 8).map((s) => refOf(s.t)) };
}

/** Standard "couldn't resolve" payload for an MCP tool result, pointing the
 *  caller at `studio_list_templates`. */
export function unresolvedTemplateError(input: string): {
  error: string;
  hint: string;
} {
  return {
    error: `No template matches "${input}".`,
    hint: 'Call studio_list_templates (optionally with `q` for a text search, e.g. q: "wan vace inpaint") to get valid template names, then retry with the exact `name` from that list.',
  };
}

/** Standard "ambiguous" payload — hands back candidates for the model to pick. */
export function ambiguousTemplateError(input: string, candidates: TemplateRef[]): {
  error: string;
  candidates: TemplateRef[];
} {
  return {
    error: `"${input}" is ambiguous. Pick one of the template names below and retry with the exact \`name\`.`,
    candidates,
  };
}
