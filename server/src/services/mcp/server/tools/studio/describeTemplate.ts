// Studio MCP tool: full metadata for a single template.
//
// Accepts the template `name` (slug) — but tolerates a guessed title or
// partial name: on a miss it fuzzy-resolves and either uses the single match,
// hands back candidates to disambiguate, or points the caller at
// studio_list_templates.

import { z } from 'zod';
import { getTemplate } from '../../../../templates/index.js';
import {
  resolveTemplateName,
  unresolvedTemplateError,
  ambiguousTemplateError,
} from '../../../../templates/resolveTemplateName.js';
import * as templateRepo from '../../../../../lib/db/templates.repo.js';

export const description =
  'Return full metadata for a single template: form inputs, required models/plugins, readiness. '
  + 'Pass the `name` from studio_list_templates; a title or partial name is fuzzy-matched.';

export const inputShape = {
  name: z.string().min(1).describe(
    'Template name (the `name` field from studio_list_templates). A title or partial name will be fuzzy-matched.',
  ),
};

export interface DescribeTemplateArgs {
  name: string;
}

export async function run(args: DescribeTemplateArgs): Promise<unknown> {
  let name = args.name;
  let t = getTemplate(name);

  if (!t) {
    const resolved = resolveTemplateName(args.name);
    if (!resolved) return unresolvedTemplateError(args.name);
    if ('candidates' in resolved) return ambiguousTemplateError(args.name, resolved.candidates);
    name = resolved.name;
    t = getTemplate(name);
    if (!t) return { error: `Template "${name}" not found.` };
  }

  const row = templateRepo.getTemplate(name);
  const ready = row?.installed ?? false;

  return {
    name: t.name,
    ...(t.name !== args.name ? { resolvedFrom: args.name } : {}),
    title: t.title,
    description: t.description,
    mediaType: t.mediaType,
    studioCategory: t.studioCategory ?? 'image',
    formInputs: t.formInputs ?? [],
    widgets: [],
    models: t.models ?? [],
    plugins: (t.plugins ?? []).map((p) => ({
      repo: p.repo,
      title: p.title,
      installed: p.installed ?? false,
    })),
    ready,
    missing: [],
  };
}
