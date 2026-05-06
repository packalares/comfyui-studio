// search_models — Search HuggingFace for ComfyUI-compatible models.
// Source: artokun tools/model-management.ts (search_models section).

import { logger } from '../../../../../lib/logger.js';
import { searchHuggingFaceModels } from './_lib/hfSearch.js';

export interface SearchModelsArgs {
  query: string;
  filter?: string;
  limit?: number;
}

export interface SearchModelsResult {
  text: string;
  error?: string;
}

/**
 * Search HuggingFace for models compatible with ComfyUI (checkpoints,
 * LoRAs, VAEs, etc.). Optionally filter by HuggingFace pipeline tag.
 */
export async function searchModels(args: SearchModelsArgs): Promise<SearchModelsResult> {
  try {
    logger.info('MCP searchModels', { query: args.query, filter: args.filter, limit: args.limit });

    const results = await searchHuggingFaceModels(args.query, {
      filter: args.filter,
      limit: args.limit,
    });

    if (results.length === 0) {
      return { text: `No models found for "${args.query}".` };
    }

    const text = results
      .map(
        (m, i) =>
          `${i + 1}. **${m.modelId}** by ${m.author || 'unknown'}\n` +
          `   Downloads: ${m.downloads.toLocaleString()} | Likes: ${m.likes}\n` +
          `   Tags: ${m.tags.slice(0, 5).join(', ') || 'none'}`,
      )
      .join('\n\n');

    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP searchModels error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
