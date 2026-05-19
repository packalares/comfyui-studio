// Studio MCP tool: full dependency check for a template.
//
// `name` is fuzzy-resolved (the LLM often passes a guessed display title) —
// an exact slug or single match is checked; an ambiguous reference returns
// candidates instead.

import { z } from 'zod';
import { checkTemplateDependencies } from '../../../../templates/dependencyCheck.js';
import * as templateRepo from '../../../../../lib/db/templates.repo.js';
import {
  resolveTemplateName,
  unresolvedTemplateError,
  ambiguousTemplateError,
} from '../../../../templates/resolveTemplateName.js';

export const description =
  'Run the full dependency check for a template and return required/missing models and plugins. '
  + 'Pass the `name` from studio_list_templates; a title or partial name is fuzzy-matched.';

export const inputShape = {
  name: z.string().min(1).describe(
    'Template name (the `name` from studio_list_templates). A title or partial name is fuzzy-matched.',
  ),
};

export interface CheckDependenciesArgs {
  name: string;
}

export async function run(args: CheckDependenciesArgs): Promise<unknown> {
  let name = args.name;
  if (!templateRepo.getTemplate(name)) {
    const resolved = resolveTemplateName(args.name);
    if (!resolved) return unresolvedTemplateError(args.name);
    if ('candidates' in resolved) return ambiguousTemplateError(args.name, resolved.candidates);
    name = resolved.name;
  }
  const result = await checkTemplateDependencies(name);
  return name !== args.name ? { resolvedFrom: args.name, ...(result as object) } : result;
}
