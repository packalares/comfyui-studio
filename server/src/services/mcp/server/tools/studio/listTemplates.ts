// Studio MCP tool: list templates with optional filters.
// Exports `inputShape`, `description`, `run` for the unified toolRegistry.
// DB-first: reads directly from SQLite instead of the old in-memory cache.

import { z } from 'zod';
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

export async function run(args: ListTemplatesArgs): Promise<unknown> {
  const limit = args.limit ?? 50;
  const readyFilter = args.ready === true ? 'yes' : args.ready === false ? 'no' : 'all';

  const result = templateRepo.listPaginated(
    {
      q: args.q || undefined,
      ready: readyFilter,
    },
    1,
    limit,
  );

  const items = result.items
    .filter((t) => {
      if (args.modality && t.media_type !== args.modality) return false;
      return true;
    })
    .map((t) => ({
      name: t.name,
      title: t.displayName,
      mediaType: t.media_type,
      studioCategory: t.media_type ?? 'image',
      tags: t.tags ?? [],
      ready: t.installed,
    }));

  return { items };
}
