// Studio MCP tool: list recent gallery outputs, optionally filtered.

import { z } from 'zod';
import * as galleryRepo from '../../../../../lib/db/gallery.repo.js';

export const description = 'List recent generation outputs from the Studio gallery.';

export const inputShape = {
  since: z.string().optional()
    .describe('ISO 8601 date string; return only outputs created after this time'),
  limit: z.number().int().min(1).max(100).optional()
    .describe('Max items to return (default 20)'),
  modality: z.string().optional()
    .describe('Filter by mediaType (image, video, audio)'),
};

export interface ListRecentOutputsArgs {
  since?: string;
  limit?: number;
  modality?: string;
}

export async function run(args: ListRecentOutputsArgs): Promise<unknown> {
  const limit = args.limit ?? 20;
  const filter: { mediaType?: string; sort?: 'newest' } = { sort: 'newest' };
  if (args.modality) filter.mediaType = args.modality;

  const all = galleryRepo.listAll(filter);

  let items = all;
  if (args.since) {
    const sinceMs = new Date(args.since).getTime();
    if (!Number.isNaN(sinceMs)) {
      items = items.filter((r) => (r.createdAt ?? 0) > sinceMs);
    }
  }
  items = items.slice(0, limit);

  return {
    items: items.map((r) => ({
      id: r.id,
      filename: r.filename,
      mediaType: r.mediaType,
      url: r.url,
      promptId: r.promptId,
      templateName: r.templateName ?? null,
      createdAt: r.createdAt,
    })),
  };
}
