// Studio MCP tool: full dependency check for a template.

import { z } from 'zod';
import { checkTemplateDependencies } from '../../../../templates/dependencyCheck.js';

export const description =
  'Run the full dependency check for a template and return required/missing models and plugins.';

export const inputShape = {
  name: z.string().min(1).describe('Template name (slug)'),
};

export interface CheckDependenciesArgs {
  name: string;
}

export async function run(args: CheckDependenciesArgs): Promise<unknown> {
  return await checkTemplateDependencies(args.name);
}
