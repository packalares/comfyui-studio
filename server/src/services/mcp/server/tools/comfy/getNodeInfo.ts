// get_node_info — Query ComfyUI's /object_info endpoint.
// Source: artokun tools/workflow-compose.ts (get_node_info section).

import { logger } from '../../../../../lib/logger.js';
import { getObjectInfo } from './_lib/comfyClient.js';

export interface GetNodeInfoArgs {
  node_type?: string;
}

export interface GetNodeInfoResult {
  text: string;
  error?: string;
}

/**
 * Query ComfyUI's /object_info. Optionally filter by node type name
 * (case-insensitive substring match). Returns full definitions for
 * <= 20 matches; returns a compact name+description summary for larger sets.
 */
export async function getNodeInfo(args: GetNodeInfoArgs): Promise<GetNodeInfoResult> {
  try {
    logger.info('MCP getNodeInfo', { filter: args.node_type });
    const info = await getObjectInfo();

    let entries = Object.entries(info);
    if (args.node_type) {
      const lower = args.node_type.toLowerCase();
      entries = entries.filter(([name]) => name.toLowerCase().includes(lower));
    }

    if (entries.length === 0) {
      return {
        text: args.node_type
          ? `No nodes found matching "${args.node_type}"`
          : 'No node definitions returned from ComfyUI',
      };
    }

    if (entries.length > 20) {
      const summary = entries.map(([name, def]) => ({
        name,
        display_name: def.display_name,
        category: def.category,
        description: def.description ?? '',
      }));
      return {
        text: JSON.stringify(
          {
            count: summary.length,
            nodes: summary,
            hint: 'Use a more specific node_type filter to see full definitions with inputs/outputs',
          },
          null,
          2,
        ),
      };
    }

    return { text: JSON.stringify(Object.fromEntries(entries), null, 2) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP getNodeInfo error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
