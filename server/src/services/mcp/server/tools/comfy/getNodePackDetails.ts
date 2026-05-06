// get_node_pack_details — Fetch detailed info about a ComfyUI Registry node pack.
// Source: artokun tools/registry-search.ts (get_node_pack_details section).

import { logger } from '../../../../../lib/logger.js';
import { getNodePackDetails as fetchPackDetails } from './_lib/registryClient.js';

export interface GetNodePackDetailsArgs {
  id: string;
}

export interface GetNodePackDetailsResult {
  text: string;
  error?: string;
}

/**
 * Get detailed information about a specific custom node pack from the
 * ComfyUI Registry (https://api.comfy.org/nodes/:id).
 */
export async function getNodePackDetails(
  args: GetNodePackDetailsArgs,
): Promise<GetNodePackDetailsResult> {
  try {
    logger.info('MCP getNodePackDetails', { id: args.id });

    const details = await fetchPackDetails(args.id);

    const lines = [
      `# ${details.name}`,
      '',
      details.description ?? '',
      '',
      `- **Author**: ${details.author}`,
      `- **License**: ${details.license ?? 'N/A'}`,
      `- **Repository**: ${details.repository ?? 'N/A'}`,
      `- **Total Installs**: ${details.total_install ?? 'N/A'}`,
      `- **Latest Version**: ${details.latest_version ?? 'N/A'}`,
      `- **Created**: ${details.created_at ?? 'N/A'}`,
      `- **Updated**: ${details.updated_at ?? 'N/A'}`,
    ];

    if (details.nodes?.length) {
      lines.push('', '## Nodes Provided', ...details.nodes.map(n => `- ${n}`));
    }

    if (details.versions?.length) {
      lines.push(
        '',
        '## Recent Versions',
        ...details.versions.slice(0, 5).map(
          v => `- **${v.version}**${v.changelog ? `: ${v.changelog}` : ''}`,
        ),
      );
    }

    return { text: lines.join('\n') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP getNodePackDetails error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
