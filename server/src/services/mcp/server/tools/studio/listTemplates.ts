// Studio MCP tool: list templates with optional filters.
// Exports `inputShape`, `description`, `run` for the unified toolRegistry.

import { z } from 'zod';
import { getTemplates } from '../../../../templates/index.js';
import * as templateRepo from '../../../../../lib/db/templates.repo.js';

export const description =
  'List Studio templates with optional modality/readiness/text filters.';

export const inputShape = {
  modality: z.enum(['image', 'video', 'audio', '3d']).optional()
    .describe('Filter by media category (studioCategory)'),
  ready: z.boolean().optional()
    .describe('When true, return only templates with all deps installed'),
  q: z.string().optional()
    .describe('Free-text search across name, title, tags'),
  limit: z.number().int().min(1).max(200).optional()
    .describe('Max items to return (default 50)'),
};

export interface ListTemplatesArgs {
  modality?: 'image' | 'video' | 'audio' | '3d';
  ready?: boolean;
  q?: string;
  limit?: number;
}

function matchesQuery(name: string, title: string, tags: string[], q: string): boolean {
  const lq = q.toLowerCase();
  return (
    name.toLowerCase().includes(lq) ||
    title.toLowerCase().includes(lq) ||
    tags.some((tag) => tag.toLowerCase().includes(lq))
  );
}

export async function run(args: ListTemplatesArgs): Promise<unknown> {
  const limit = args.limit ?? 50;
  const raw = getTemplates();
  const readinessMap = new Map<string, boolean>();
  for (const name of templateRepo.listAllNames()) {
    const row = templateRepo.getTemplate(name);
    if (row) readinessMap.set(name, row.installed);
  }

  const items = raw
    .filter((t) => {
      if (args.modality && t.studioCategory !== args.modality) return false;
      if (args.ready !== undefined && (readinessMap.get(t.name) ?? false) !== args.ready) {
        return false;
      }
      if (args.q && !matchesQuery(t.name, t.title, t.tags ?? [], args.q)) return false;
      return true;
    })
    .slice(0, limit)
    .map((t) => ({
      name: t.name,
      title: t.title,
      mediaType: t.mediaType,
      studioCategory: t.studioCategory ?? 'image',
      tags: t.tags ?? [],
      ready: readinessMap.get(t.name) ?? false,
    }));

  return { items };
}
