// HuggingFace model search helper.
// Ported from artokun's services/model-resolver.ts (search portion only —
// local-file and download logic is not needed here).

import { logger } from '../../../../../../lib/logger.js';

export interface HFModelResult {
  id: string;
  modelId: string;
  author: string;
  tags: string[];
  downloads: number;
  likes: number;
  lastModified: string;
}

export async function searchHuggingFaceModels(
  query: string,
  options: { filter?: string; limit?: number } = {},
): Promise<HFModelResult[]> {
  const { filter, limit = 10 } = options;
  const params = new URLSearchParams({ search: query, limit: String(limit) });
  if (filter) params.set('filter', filter);

  const url = `https://huggingface.co/api/models?${params}`;
  logger.debug('HuggingFace API request', { url });

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HuggingFace API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as Array<Record<string, unknown>>;
  return data.map(m => ({
    id: String(m.id ?? m._id ?? ''),
    modelId: String(m.modelId ?? m.id ?? ''),
    author: String(m.author ?? ''),
    tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
    downloads: Number(m.downloads ?? 0),
    likes: Number(m.likes ?? 0),
    lastModified: String(m.lastModified ?? ''),
  }));
}
