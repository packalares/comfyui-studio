// get_system_stats — Fetch ComfyUI system info (GPU, VRAM, Python, OS).
// Source: artokun tools/workflow-execute.ts (get_system_stats section).

import { logger } from '../../../../../lib/logger.js';
import { getSystemStats as fetchStats } from './_lib/comfyClient.js';

export interface GetSystemStatsResult {
  text: string;
  error?: string;
}

/**
 * Get ComfyUI system information including GPU, VRAM, Python version,
 * and OS details from /api/system_stats.
 */
export async function getSystemStats(): Promise<GetSystemStatsResult> {
  try {
    logger.info('MCP getSystemStats');
    const stats = await fetchStats();
    return { text: JSON.stringify(stats, null, 2) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP getSystemStats error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
