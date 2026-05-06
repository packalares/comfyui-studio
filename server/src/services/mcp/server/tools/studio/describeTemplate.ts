// Studio MCP tool: full metadata for a single template.

import { z } from 'zod';
import { getTemplate } from '../../../../templates/index.js';
import * as templateRepo from '../../../../../lib/db/templates.repo.js';

export const description =
  'Return full metadata for a single template: form inputs, required models/plugins, readiness.';

export const inputShape = {
  name: z.string().min(1).describe('Template name (slug)'),
};

export interface DescribeTemplateArgs {
  name: string;
}

export async function run(args: DescribeTemplateArgs): Promise<unknown> {
  const t = getTemplate(args.name);
  if (!t) throw new Error(`Template "${args.name}" not found`);

  const row = templateRepo.getTemplate(args.name);
  const ready = row?.installed ?? false;

  return {
    name: t.name,
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
