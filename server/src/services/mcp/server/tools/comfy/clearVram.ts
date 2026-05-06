// clear_vram — Free GPU VRAM by unloading cached models from ComfyUI.
// Source: artokun tools/memory-management.ts (clear_vram section).

import { logger } from '../../../../../lib/logger.js';
import { postFree, getSystemStats } from './_lib/comfyClient.js';

export interface ClearVramArgs {
  unload_models?: boolean;
  free_memory?: boolean;
}

export interface ClearVramResult {
  text: string;
  error?: string;
}

/**
 * Free GPU VRAM via ComfyUI's /free endpoint. Optionally unloads cached models
 * and/or frees cached memory/intermediates. Both default to true.
 * Returns a summary with current VRAM stats after the operation.
 */
export async function clearVram(args: ClearVramArgs): Promise<ClearVramResult> {
  const unload_models = args.unload_models ?? true;
  const free_memory = args.free_memory ?? true;

  try {
    logger.info('MCP clearVram', { unload_models, free_memory });

    const res = await postFree({ unload_models, free_memory });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `Failed to free VRAM: ${res.status} ${res.statusText}${body ? `\n${body}` : ''}`;
      return { text: msg, error: msg };
    }

    // Best-effort: grab updated VRAM stats
    let statsText = '';
    try {
      const stats = await getSystemStats();
      const gpu = stats.devices?.[0];
      if (gpu) {
        const vramFreeMB = (gpu.vram_free / 1024 / 1024).toFixed(0);
        const vramTotalMB = (gpu.vram_total / 1024 / 1024).toFixed(0);
        const torchFreeMB = (gpu.torch_vram_free / 1024 / 1024).toFixed(0);
        const torchTotalMB = (gpu.torch_vram_total / 1024 / 1024).toFixed(0);
        statsText = `\n\nCurrent VRAM: ${vramFreeMB}/${vramTotalMB} MB free | Torch: ${torchFreeMB}/${torchTotalMB} MB free`;
      }
    } catch {
      // Non-fatal — stats are informational
    }

    const actions: string[] = [];
    if (unload_models) actions.push('models unloaded');
    if (free_memory) actions.push('memory freed');

    return { text: `VRAM cleared successfully (${actions.join(', ')}).${statsText}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('MCP clearVram error', { error: msg });
    return { text: `Error: ${msg}`, error: msg };
  }
}
