// search_custom_nodes — Search the ComfyUI Registry for custom node packs.
// Source: artokun tools/registry-search.ts (search_custom_nodes section).

import { logger } from '../../../../../lib/logger.js';
import { searchNodes } from './_lib/registryClient.js';

export interface SearchCustomNodesArgs {
  query: string;
  limit?: number;
  page?: number;
}

export interface SearchCustomNodesResult {
  text: string;
  error?: string;
}

/**
 * Search https://api.comfy.org/nodes for custom node packs by keyword.
 */
export async function searchCustomNodes(
  args: SearchCustomNodesArgs,
): Promise<SearchCustomNodesResult> {
  try {
    logger.info('MCP searchCustomNodes', { query: args.query });

    const results = await searchNodes(args.query, {
      limit: args.limit,
      page: args.page,
    });

    if (results.length === 0) {
      return { text: `No custom nodes found for "${args.query}".` };
    }

    const text = results
      .map(
        (r, i) =>
          `${i + 1}. **${r.name}** (${r.id})\n` +
          `   ${r.description ?? 'No description'}\n` +
          `   Author: ${r.author} | Installs: ${r.total_install ?? 'N/A'} | Version: ${r.latest_version ?? 'N/A'}`,
      )
      .join('\n\n');

    return { text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP searchCustomNodes error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
